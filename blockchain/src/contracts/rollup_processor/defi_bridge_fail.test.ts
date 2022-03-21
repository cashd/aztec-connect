import { EthAddress } from '@aztec/barretenberg/address';
import { Asset, TxHash } from '@aztec/barretenberg/blockchain';
import { BridgeId } from '@aztec/barretenberg/bridge_id';
import { computeInteractionHashes, DefiInteractionNote } from '@aztec/barretenberg/note_algorithms';
import { WorldStateConstants } from '@aztec/barretenberg/world_state';
import { RollupProofData } from '@aztec/barretenberg/rollup_proof/rollup_proof_data';
import { randomBytes } from 'crypto';
import { Signer } from 'ethers';
import { LogDescription } from 'ethers/lib/utils';
import { ethers } from 'hardhat';
import { createRollupProof, createSendProof, DefiInteractionData } from './fixtures/create_mock_proof';
import { deployMockBridge, MockBridgeParams } from './fixtures/setup_defi_bridges';
import { setupTestRollupProcessor } from './fixtures/setup_test_rollup_processor';
import { TestRollupProcessor } from './fixtures/test_rollup_processor';

const parseInteractionResultFromLog = (log: LogDescription) => {
  const {
    args: { bridgeId, nonce, totalInputValue, totalOutputValueA, totalOutputValueB, result },
  } = log;
  return new DefiInteractionNote(
    BridgeId.fromBigInt(BigInt(bridgeId)),
    nonce.toNumber(),
    BigInt(totalInputValue),
    BigInt(totalOutputValueA),
    BigInt(totalOutputValueB),
    result,
  );
};

describe('rollup_processor: defi bridge failures', () => {
  let rollupProcessor: TestRollupProcessor;
  let assets: Asset[];
  let signers: Signer[];
  let addresses: EthAddress[];
  let rollupProvider: Signer;
  let assetAddresses: EthAddress[];

  const numberOfBridgeCalls = RollupProofData.NUM_BRIDGE_CALLS_PER_BLOCK;

  const topupToken = async (assetId: number, amount: bigint) =>
    assets[assetId].mint(amount, rollupProcessor.address, { signingAddress: addresses[0] });

  const topupEth = async (amount: bigint) =>
    signers[0].sendTransaction({ to: rollupProcessor.address.toString(), value: Number(amount) });

  const dummyProof = () => createSendProof(0);

  const mockBridge = async (params: MockBridgeParams = {}) =>
    deployMockBridge(rollupProvider, rollupProcessor, assetAddresses, params);

  const expectResult = async (expectedResult: DefiInteractionNote[], txHash: TxHash) => {
    const receipt = await ethers.provider.getTransactionReceipt(txHash.toString());
    const interactionResult = receipt.logs
      .filter(l => l.address === rollupProcessor.address.toString())
      .map(l => rollupProcessor.contract.interface.parseLog(l))
      .filter(e => e.eventFragment.name === 'DefiBridgeProcessed')
      .map(parseInteractionResultFromLog);
    expect(interactionResult.length).toBe(expectedResult.length);
    for (let i = 0; i < expectedResult.length; ++i) {
      expect(interactionResult[i]).toEqual(expectedResult[i]);
    }

    const expectedHashes = computeInteractionHashes([
      ...expectedResult,
      ...[...Array(numberOfBridgeCalls - expectedResult.length)].map(() => DefiInteractionNote.EMPTY),
    ]);

    const hashes = await rollupProcessor.defiInteractionHashes();
    const resultHashes = [
      ...hashes,
      ...[...Array(numberOfBridgeCalls - hashes.length)].map(() => WorldStateConstants.EMPTY_INTERACTION_HASH),
    ];
    expect(expectedHashes).toEqual(resultHashes);
  };

  const expectBalance = async (assetId: number, balance: bigint) =>
    expect(await assets[assetId].balanceOf(rollupProcessor.address)).toBe(balance);

  const expectRefund = async (bridgeId: BridgeId, inputValue: bigint, txHash: TxHash) => {
    await expectBalance(bridgeId.inputAssetIdA, inputValue);
    await expectBalance(bridgeId.outputAssetIdA, 0n);
    if (bridgeId.bitConfig.secondOutputReal) {
      await expectBalance(bridgeId.outputAssetIdB, 0n);
    }
    await expectResult([new DefiInteractionNote(bridgeId, 0, inputValue, 0n, 0n, false)], txHash);
  };

  beforeEach(async () => {
    signers = await ethers.getSigners();
    rollupProvider = signers[0];
    addresses = await Promise.all(signers.map(async u => EthAddress.fromString(await u.getAddress())));
    ({ rollupProcessor, assets, assetAddresses } = await setupTestRollupProcessor(signers));
  });

  it('process failed defi interaction that converts token to eth', async () => {
    const bridgeId = await mockBridge({
      inputAssetIdA: 1,
      outputAssetIdA: 0,
      canConvert: false,
    });

    const inputValue = 10n;
    await topupToken(1, inputValue);

    await expectBalance(1, inputValue);
    await expectBalance(0, 0n);
    const { proofData } = await createRollupProof(rollupProvider, dummyProof(), {
      defiInteractionData: [new DefiInteractionData(bridgeId, inputValue)],
    });
    const tx = await rollupProcessor.createRollupProofTx(proofData, [], []);
    const txHash = await rollupProcessor.sendTx(tx);

    await expectRefund(bridgeId, inputValue, txHash);
  });

  it('process failed defi interaction that converts eth to token', async () => {
    const bridgeId = await mockBridge({
      inputAssetIdA: 0,
      outputAssetIdA: 1,
      canConvert: false,
    });

    const inputValue = 10n;
    await topupEth(inputValue);

    await expectBalance(0, inputValue);
    await expectBalance(1, 0n);

    const { proofData } = await createRollupProof(rollupProvider, dummyProof(), {
      defiInteractionData: [new DefiInteractionData(bridgeId, inputValue)],
    });
    const tx = await rollupProcessor.createRollupProofTx(proofData, [], []);
    const txHash = await rollupProcessor.sendTx(tx);

    await expectRefund(bridgeId, inputValue, txHash);
  });

  it('revert if prev defiInteraction hash is wrong', async () => {
    const { proofData } = await createRollupProof(rollupProvider, dummyProof(), {
      previousDefiInteractionHash: randomBytes(32),
    });
    const tx = await rollupProcessor.createRollupProofTx(proofData, [], []);
    await expect(rollupProcessor.sendTx(tx)).rejects.toThrow('INCORRECT_PREVIOUS_DEFI_INTERACTION_HASH');
  });

  it('revert if total input value is empty', async () => {
    const bridgeId = await mockBridge();
    const inputValue = 0n;
    const { proofData } = await createRollupProof(rollupProvider, dummyProof(), {
      defiInteractionData: [new DefiInteractionData(bridgeId, inputValue)],
    });
    const tx = await rollupProcessor.createRollupProofTx(proofData, [], []);
    await expect(rollupProcessor.sendTx(tx)).rejects.toThrow('ZERO_TOTAL_INPUT_VALUE');
  });

  it('process defi interaction data fails if defiInteractionHash is max size', async () => {
    const outputValueA = 15n;
    const bridgeId = await mockBridge({
      inputAssetIdA: 1,
      outputAssetIdA: 0,
      outputValueA,
    });
    const inputValue = 20n;

    await topupToken(1, inputValue);

    await expectBalance(1, inputValue);
    await expectBalance(0, 0n);

    const { proofData } = await createRollupProof(rollupProvider, dummyProof(), {
      defiInteractionData: [new DefiInteractionData(bridgeId, inputValue)],
    });

    await rollupProcessor.stubTransactionHashes(1023);
    // when processDefiInteractions is called, NUM_BRIDGE_CALLS will be popped off of the defiInteractionHashes array.
    // 1 defi interaction hash is then added due to the rollup proof containing a DefiInteractionData object.
    // if we then copy NUM_BRIDGE_CALLS async tx hashes into defiInteractionHashes, we should trigger the array overflow
    await rollupProcessor.stubAsyncTransactionHashes(RollupProofData.NUM_BRIDGE_CALLS_PER_BLOCK);
    const tx = await rollupProcessor.createRollupProofTx(proofData, [], []);
    await expect(rollupProcessor.sendTx(tx)).rejects.toThrow('ARRAY_OVERFLOW');
  });
});