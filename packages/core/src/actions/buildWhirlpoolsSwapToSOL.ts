import BN from 'bn.js';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
    createBurnInstruction,
    createTransferInstruction,
    getAssociatedTokenAddress,
    getMinimumBalanceForRentExemptAccount,
    NATIVE_MINT,
} from '@solana/spl-token';
import { SwapQuote } from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import type { Cache } from 'cache-manager';

import { simulateRawTransaction, isMainnetBetaCluster, MessageToken } from '../core';
import { whirlpools } from '../swapProviders';
import { getPriorityFeeInstructions } from './applyPriorityFeesToTransaction';

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
    slippingTolerance: Percentage,
    cache: Cache,
    sameMintTimeout = 3000,
    feeOptions?: FeeOptions
): Promise<{ transaction: Transaction; quote: QuoteResponse; messageToken: string }> {
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
    const transferFee = feeOptions?.transferFeeBp ? amount.muln(feeOptions.transferFeeBp).divn(10000) : new BN(0);
    const swapAmount = amount.sub(burnFee).sub(transferFee);

    // Swapping SOL to USDC with input 0.1 SOL and 0.5% slippage
    const outputMint = 'So11111111111111111111111111111111111111112';
    const params = new URLSearchParams();
    params.append('inputMint', sourceMint.toString());
    params.append('outputMint', outputMint);
    params.append('amount', swapAmount.toString()); // Convert number to string
    params.append('asLegacyTransaction', 'true');
    // params.append('slippageBps', slippageBps.toString());

    const url = new URL('https://quote-api.jup.ag/v6/quote');
    url.search = params.toString();

    const quoteResponse = await (await fetch(url)).json();
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
                asLegacyTransaction: true,
            }),
        })
    ).json();

    if (instructions.error) {
        throw new Error('Failed to get swap instructions: ' + instructions.error);
    }
    const {
        computeBudgetInstructions, // The necessary instructions to setup the compute budget.
        setupInstructions, // Setup missing ATA for the users.
        swapInstruction: swapInstructionPayload, // The actual swap instruction.
        cleanupInstruction, // Unwrap the SOL if `wrapAndUnwrapSol = true`.
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

    // const blockhash = (await connection.getLatestBlockhash()).blockhash;
    // const;

    // const messageV0 = new TransactionMessage({
    //     payerKey: payerPublicKey,
    //     recentBlockhash: blockhash,
    //     instructions: [
    //         // uncomment if needed: ...setupInstructions.map(deserializeInstruction),
    //         deserializeInstruction(swapInstructionPayload),
    //         // uncomment if needed: deserializeInstruction(cleanupInstruction),
    //     ],
    // }).compileToV0Message(addressLookupTableAccounts);
    // const transaction = new VersionedTransaction(messageV0);

    // let feeBurnInstruction: TransactionInstruction | undefined;
    // let feeTransferInstruction: TransactionInstruction | undefined;
    // if (feeOptions !== undefined && burnFee.gtn(0)) {
    //     feeBurnInstruction = createBurnInstruction(
    //         feeOptions.sourceAccount,
    //         sourceMint,
    //         user,
    //         BigInt(burnFee.toString())
    //     );
    // }
    // if (feeOptions !== undefined && transferFee.gtn(0)) {
    //     feeTransferInstruction = createTransferInstruction(
    //         feeOptions.sourceAccount,
    //         feeOptions.destinationAccount,
    //         user,
    //         BigInt(transferFee.toString())
    //     );
    // }

    // const instructions: TransactionInstruction[] = [
    //     ...computeBudgetInstructions,
    //     ...setupInstructions,
    //     swapInstruction,
    //     cleanupInstruction,
    // ];

    // if (feeBurnInstruction) instructions.unshift(feeBurnInstruction);
    // if (feeTransferInstruction) instructions.unshift(feeTransferInstruction);

    const transaction = new Transaction({
        feePayer: feePayer.publicKey,
        ...(await connection.getLatestBlockhash()),
    })
        .add(...computeBudgetInstructions.map(deserializeInstruction))
        .add(...setupInstructions.map(deserializeInstruction))
        .add(deserializeInstruction(swapInstructionPayload))
        .add(deserializeInstruction(cleanupInstruction));

    await simulateRawTransaction(connection, transaction.serialize({ verifySignatures: false }));

    let messageToken: any;
    try {
        // const compiled
        messageToken = new MessageToken(whirlpools.MESSAGE_TOKEN_KEY, transaction.compileMessage(), feePayer).compile();
    } catch (e) {
        console.log('Error creating token');
        throw e;
    }

    // set last signature for mint and user
    await cache.set<number>(key, Date.now());

    return { transaction, quote: quoteResponse, messageToken };
}
