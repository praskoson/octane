import {
    NATIVE_MINT,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountIdempotentInstruction,
    getAssociatedTokenAddressSync,
    createCloseAccountInstruction,
    createBurnInstruction,
} from '@solana/spl-token';
import {
    AddressLookupTableAccount,
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import type { Cache } from 'cache-manager';

import { MessageToken, isMainnetBetaCluster, simulateV0Transaction } from '../core';
import { MESSAGE_TOKEN_KEY } from '../swapProviders/whirlpools';

export type FeeOptions = {
    amount: number;
    sourceAccount: PublicKey;
    destinationAccount: PublicKey;
    transferFeeBp: number;
    burnFeeBp: number;
};

export type QuoteResponse = {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: 'ExactIn' | 'ExactOut';
    slippageBps: number;
    platformFee?: {
        amount: string;
        feeBps: number;
    };
    priceImpactPct: string;
    contextSlot?: number;
    timeTaken?: number;
};

/**
 * Builds an unsigned transaction that performs a swap to SOL and optionally sends a token fee to Octane
 *
 * @param connection
 * @param feePayer
 * @param user
 * @param sourceMint
 * @param amount
 * @param slippingTolerance
 * @param cache
 * @param sameMintTimeout A required interval for transactions with same source mint and user, ms
 * @param feeOptions?
 *
 * @return Transaction
 */
export async function buildWhirlpoolsSwapToSOL(
    connection: Connection,
    feePayer: Keypair,
    user: PublicKey,
    sourceMint: PublicKey,
    amount: BN,
    cache: Cache,
    sameMintTimeout = 3000,
    feeOptions?: FeeOptions
): Promise<{ transaction: VersionedTransaction; quote: QuoteResponse; messageToken: string }> {
    // Connection's genesis hash is cached to prevent an extra RPC query to the node on each call.
    const genesisHashKey = `genesis/${connection.rpcEndpoint}`;
    let genesisHash = await cache.get<string>(genesisHashKey);
    if (!genesisHash) {
        genesisHash = await connection.getGenesisHash();
        await cache.set<string>(genesisHashKey, genesisHash);
    }
    if (!isMainnetBetaCluster(genesisHash)) {
        throw new Error('Whirlpools endpoint can only run attached to the mainnet-beta cluster');
    }

    if (amount.lte(new BN(0))) {
        throw new Error("Amount can't be zero or less");
    }

    if (feeOptions && feeOptions.amount < 0) {
        throw new Error("Fee can't be less than zero");
    }

    const key = `swap/${user.toString()}/${sourceMint.toString()}`;
    const lastSignature = await cache.get<number>(key);
    if (lastSignature && Date.now() - lastSignature < sameMintTimeout) {
        throw new Error('Too many requests for same user and mint');
    }
    // cache.set() is in the end of the function

    const associatedSOLAddress = await getAssociatedTokenAddress(NATIVE_MINT, user);
    if (await connection.getAccountInfo(associatedSOLAddress)) {
        throw new Error('Associated SOL account exists for user');
    }

    const burnFee = feeOptions?.burnFeeBp ? amount.muln(feeOptions.burnFeeBp).divn(10000) : new BN(0);
    const swapAmount = amount.sub(burnFee);

    const outputMint = 'So11111111111111111111111111111111111111112';
    const params = new URLSearchParams();
    params.append('inputMint', sourceMint.toString());
    params.append('outputMint', outputMint);
    params.append('amount', swapAmount.toString()); // Convert number to string
    params.append('slippageBps', '1000');

    const url = new URL('https://quote-api.jup.ag/v6/quote');
    url.search = params.toString();

    const quoteResponse = await (await fetch(url)).json();
    const solFeeRatio = 250; // bps
    const platformFee = Math.round(Number(quoteResponse.outAmount) * (solFeeRatio / 10000));
    const instructions = await (
        await fetch('https://quote-api.jup.ag/v6/swap-instructions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                quoteResponse,
                userPublicKey: user.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: 'auto',
            }),
        })
    ).json();

    if (instructions.error) {
        throw new Error('Failed to get swap instructions: ' + instructions.error);
    }
    const {
        computeBudgetInstructions, // The necessary instructions to setup the compute budget.
        // setupInstructions, // Setup missing ATA for the users.
        swapInstruction: swapInstructionPayload, // The actual swap instruction.
        // cleanupInstruction, // Unwrap the SOL if `wrapAndUnwrapSol = true`.
        addressLookupTableAddresses,
    } = instructions;

    const deserializeInstruction = (instruction: any) => {
        try {
            return new TransactionInstruction({
                programId: new PublicKey(instruction.programId),
                keys: instruction.accounts.map((key: any) => ({
                    pubkey: new PublicKey(key.pubkey),
                    isSigner: key.isSigner,
                    isWritable: key.isWritable,
                })),
                data: Buffer.from(instruction.data, 'base64'),
            });
        } catch (e) {
            console.log(e);
            throw e;
        }
    };

    const getAddressLookupTableAccounts = async (keys: string[]): Promise<AddressLookupTableAccount[]> => {
        const addressLookupTableAccountInfos = await connection.getMultipleAccountsInfo(
            keys.map((key) => new PublicKey(key))
        );

        return addressLookupTableAccountInfos.reduce((acc, accountInfo, index) => {
            const addressLookupTableAddress = keys[index];
            if (accountInfo) {
                const addressLookupTableAccount = new AddressLookupTableAccount({
                    key: new PublicKey(addressLookupTableAddress),
                    state: AddressLookupTableAccount.deserialize(accountInfo.data),
                });
                acc.push(addressLookupTableAccount);
            }

            return acc;
        }, new Array<AddressLookupTableAccount>());
    };

    const addressLookupTableAccounts: AddressLookupTableAccount[] = [];
    addressLookupTableAccounts.push(...(await getAddressLookupTableAccounts(addressLookupTableAddresses)));

    const LAMPORTS_PER_ATA = 2039280;
    const nativeAta = getAssociatedTokenAddressSync(NATIVE_MINT, user);
    const setupAlternateIx = createAssociatedTokenAccountIdempotentInstruction(
        feePayer.publicKey,
        nativeAta,
        user,
        NATIVE_MINT
    );
    let feeBurnInstruction: TransactionInstruction | undefined;

    if (feeOptions !== undefined && burnFee.gtn(0)) {
        feeBurnInstruction = createBurnInstruction(
            feeOptions.sourceAccount,
            sourceMint,
            user,
            BigInt(burnFee.toString())
        );
    }

    let cleanupAlternateIx = [
        createCloseAccountInstruction(nativeAta, user, user),
        SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: feePayer.publicKey,
            lamports: LAMPORTS_PER_ATA + platformFee,
        }),
    ];
    if (feeBurnInstruction) {
        cleanupAlternateIx.push(feeBurnInstruction);
    }

    const blockhash = (await connection.getLatestBlockhash()).blockhash;
    let messageV0 = new TransactionMessage({
        payerKey: feePayer.publicKey,
        recentBlockhash: blockhash,
        instructions: [
            ...computeBudgetInstructions.map(deserializeInstruction),
            setupAlternateIx,
            deserializeInstruction(swapInstructionPayload),
            ...cleanupAlternateIx,
        ],
    }).compileToV0Message(addressLookupTableAccounts);

    const transactionFee = await connection.getFeeForMessage(messageV0, 'confirmed');

    cleanupAlternateIx = [
        createCloseAccountInstruction(nativeAta, user, user),
        SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: feePayer.publicKey,
            lamports: LAMPORTS_PER_ATA + platformFee + (transactionFee?.value || 0),
        }),
    ];
    if (feeBurnInstruction) {
        cleanupAlternateIx.push(feeBurnInstruction);
    }

    messageV0 = new TransactionMessage({
        payerKey: feePayer.publicKey,
        recentBlockhash: blockhash,
        instructions: [
            ...computeBudgetInstructions.map(deserializeInstruction),
            setupAlternateIx,
            deserializeInstruction(swapInstructionPayload),
            ...cleanupAlternateIx,
        ],
    }).compileToV0Message(addressLookupTableAccounts);

    const transaction = new VersionedTransaction(messageV0);

    await simulateV0Transaction(connection, transaction);
    let messageToken: string;
    try {
        messageToken = new MessageToken(MESSAGE_TOKEN_KEY, transaction.message, feePayer).compile();
    } catch (e) {
        console.log('Error creating token');
        throw e;
    }

    // set last signature for mint and user
    await cache.set<number>(key, Date.now());

    return { transaction, quote: quoteResponse, messageToken };
}
