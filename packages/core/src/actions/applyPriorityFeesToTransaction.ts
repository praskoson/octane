import { ComputeBudgetProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

/**
 * Appends priority fee transactions to an existing transaction
 *
 * @param sourceTransaction
 *
 * @return Transaction
 */
export function appendPriorityFee(sourceTransaction: Transaction): Transaction {
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
        units: 1200000,
    });
    const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 10,
    });
    sourceTransaction.add(modifyComputeUnits).add(addPriorityFee);

    return sourceTransaction;
}

export function getPriorityFeeInstructions(): TransactionInstruction[] {
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
        units: 1200000,
    });
    const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 10,
    });
    return [modifyComputeUnits, addPriorityFee];
}
