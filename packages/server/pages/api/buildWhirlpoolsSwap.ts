import type { NextApiRequest, NextApiResponse } from 'next';
import base58 from 'bs58';
import BN from 'bn.js';

import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';

import { FeeOptions, buildWhirlpoolsSwapToSOL } from '@solana/octane-core';
import {
    cache,
    connection,
    ENV_SECRET_KEYPAIR,
    cors,
    rateLimit,
    isReturnedSignatureAllowed,
    ReturnSignatureConfigField,
} from '../../src';
import config from '../../../../config.json';

// Endpoint to pay for transactions with an SPL token transfer
export default async function (request: NextApiRequest, response: NextApiResponse) {
    await cors(request, response);
    await rateLimit(request, response);

    let user: PublicKey;
    try {
        user = new PublicKey(request.body?.user);
    } catch {
        response.status(400).send({ status: 'error', message: 'missing or invalid "user" parameter' });
        return;
    }
    let sourceMint: PublicKey;
    try {
        sourceMint = new PublicKey(request.body?.sourceMint);
    } catch {
        response.status(400).send({ status: 'error', message: 'missing or invalid "sourceMint" parameter' });
        return;
    }
    let amount: BN;
    try {
        amount = new BN(parseInt(request.body?.amount));
    } catch {
        response.status(400).send({ status: 'error', message: 'missing or invalid "amount" parameter' });
        return;
    }

    const tokenFee = config.endpoints.whirlpoolsSwap.tokens
        .map((token) => ({
            fee: BigInt(token.fee),
            decimals: token.decimals,
            mint: new PublicKey(token.mint),
            account: new PublicKey(token.account),
            transferFeeBp: token.transferFeeBp,
            burnFeeBp: token.burnFeeBp,
        }))
        .find((tokenFee) => tokenFee.mint.equals(sourceMint));

    // if (tokenFees.length === 0) {
    //     response.status(400).send({ status: 'error', message: "this source mint isn't supported" });
    //     return;
    // }

    let feeOptions: FeeOptions | undefined;
    if (tokenFee) {
        feeOptions = {
            amount: Number(tokenFee.fee),
            sourceAccount: await getAssociatedTokenAddress(sourceMint, user),
            destinationAccount: tokenFee.account,
            burnFeeBp: tokenFee.burnFeeBp,
            transferFeeBp: tokenFee.transferFeeBp,
        };
    }

    try {
        const { transaction, quote, messageToken } = await buildWhirlpoolsSwapToSOL(
            connection,
            ENV_SECRET_KEYPAIR,
            user,
            sourceMint,
            amount,
            cache,
            3000,
            feeOptions ?? undefined
        );

        if (config.returnSignature !== null) {
            if (!(await isReturnedSignatureAllowed(request, config.returnSignature as ReturnSignatureConfigField))) {
                response.status(400).send({ status: 'error', message: 'anti-spam check failed' });
                return;
            }
            transaction.sign([ENV_SECRET_KEYPAIR]);
            response.status(200).send({
                status: 'ok',
                transaction: base58.encode(transaction.serialize()),
                quote,
                messageToken,
            });
            return;
        }

        // Respond with the confirmed transaction signature
        response.status(200).send({
            status: 'ok',
            transaction: base58.encode(transaction.serialize()),
            quote,
            messageToken,
        });
    } catch (error) {
        let message = '';
        if (error instanceof Error) {
            message = error.message;
        }
        response.status(400).send({ status: 'error', message });
    }
}
