import { Contract } from '@algorandfoundation/tealscript';
import { PuppetAddress } from './puppetAddress.algo';

const TOTAL_SUPPLY = 10 ** 16;
const SCALE = 1_000;
// const DELAY = 10;

export class AMM extends Contract {
  default_manager = GlobalStateKey<Address>({ key: 'default_manager' });

  assetA = GlobalStateKey<AssetID>({ key: 'asset_a' });

  assetB = GlobalStateKey<AssetID>({ key: 'asset_b' });

  poolToken = GlobalStateKey<AssetID>({ key: 'pool_token' });

  ratio = GlobalStateKey<uint64>({ key: 'ratio' });

  currentFee = GlobalStateKey<uint64>({ key: 'current_fee' });

  maxFee = GlobalStateKey<uint64>({ key: 'max_fee' });

  poolManager = GlobalStateKey<Address>({ key: 'pool_manager' });

  topBiddersList = GlobalStateKey<StaticArray<Address, 2>>({ key: 'top_bidders_list' });

  biddersRegistry = BoxMap<Address, Address>({ prefix: 'bidders_registry' });

  highestBidAmount = GlobalStateKey<uint64>({ key: 'bid_amount' });

  createApplication(): void {
    this.default_manager.value = this.txn.sender;
    this.currentFee.value = 5;
  }

  bootstrap(seed: PayTxn, aAsset: AssetID, bAsset: AssetID, maxFee: uint64): AssetID {
    this.maxFee.value = maxFee;
    verifyAppCallTxn(this.txn, { sender: this.default_manager.value });

    // assert(globals.groupSize === 2);  is it needed ?

    verifyPayTxn(seed, { receiver: this.app.address, amount: { greaterThanEqualTo: 300_000 } });
    assert(aAsset < bAsset);

    this.assetA.value = aAsset;
    this.assetB.value = bAsset;
    this.poolToken.value = this.doCreatePoolToken(aAsset, bAsset);

    this.doOptIn(aAsset, this.app.address);
    this.doOptIn(bAsset, this.app.address);

    return this.poolToken.value;
  }

  mint(aXfer: AssetTransferTxn, bXfer: AssetTransferTxn, poolAsset: AssetID, aAsset: AssetID, bAsset: AssetID): void {
    /// well formed mint
    assert(aAsset === this.assetA.value);
    assert(bAsset === this.assetB.value);
    assert(poolAsset === this.poolToken.value);

    /// valid asset A axfer
    verifyAssetTransferTxn(aXfer, {
      sender: this.txn.sender,
      assetAmount: { greaterThan: 0 },
      assetReceiver: this.app.address,
      xferAsset: aAsset,
    });

    /// valid asset B axfer
    verifyAssetTransferTxn(bXfer, {
      sender: this.txn.sender,
      assetAmount: { greaterThan: 0 },
      assetReceiver: this.app.address,
      xferAsset: bAsset,
    });

    if (
      this.app.address.assetBalance(aAsset) === aXfer.assetAmount &&
      this.app.address.assetBalance(bAsset) === bXfer.assetAmount
    ) {
      this.tokensToMintIntial(aXfer.assetAmount, bXfer.assetAmount);
    } else {
      const toMint = this.tokensToMint(
        TOTAL_SUPPLY - this.app.address.assetBalance(poolAsset),
        this.app.address.assetBalance(aAsset) - aXfer.assetAmount,
        this.app.address.assetBalance(bAsset) - bXfer.assetAmount,
        aXfer.assetAmount,
        bXfer.assetAmount
      );

      assert(toMint > 0);

      this.doAxfer(this.app.address, this.txn.sender, poolAsset, toMint);
    }
  }

  burn(poolXfer: AssetTransferTxn, poolAsset: AssetID, aAsset: AssetID, bAsset: AssetID): void {
    /// well formed burn
    assert(poolAsset === this.poolToken.value);
    assert(aAsset === this.assetA.value);
    assert(bAsset === this.assetB.value);

    /// valid pool axfer
    verifyAssetTransferTxn(poolXfer, {
      sender: this.txn.sender,
      assetAmount: { greaterThan: 0 },
      assetReceiver: this.app.address,
      xferAsset: poolAsset,
    });

    const issued = TOTAL_SUPPLY - (this.app.address.assetBalance(poolAsset) - poolXfer.assetAmount);

    const aAmt = this.tokensToBurn(issued, this.app.address.assetBalance(aAsset), poolXfer.assetAmount);

    const bAmt = this.tokensToBurn(issued, this.app.address.assetBalance(bAsset), poolXfer.assetAmount);

    this.doAxfer(this.app.address, this.txn.sender, aAsset, aAmt);
    this.doAxfer(this.app.address, this.txn.sender, bAsset, bAmt);

    this.ratio.value = this.computeRatio();
  }

  swap(swapXfer: AssetTransferTxn, aAsset: AssetID, bAsset: AssetID): void {
    /// well formed swap
    assert(aAsset === this.assetA.value);
    assert(bAsset === this.assetB.value);

    verifyAssetTransferTxn(swapXfer, {
      assetAmount: { greaterThan: 0 },
      assetReceiver: this.app.address,
      sender: this.txn.sender,
      xferAsset: { includedIn: [aAsset, bAsset] },
    });

    const outId = swapXfer.xferAsset === aAsset ? aAsset : bAsset;

    const inId = swapXfer.xferAsset;

    const fees = this.feeToCollect(swapXfer.assetAmount);

    const toSwap = this.tokensToSwap(
      swapXfer.assetAmount - fees,
      this.app.address.assetBalance(inId) - swapXfer.assetAmount,
      this.app.address.assetBalance(outId)
    );

    assert(toSwap > 0);

    this.doAxfer(this.app.address, this.txn.sender, outId, toSwap);

    this.doAxfer(this.app.address, this.poolManager.value, inId, fees);

    this.ratio.value = this.computeRatio();
  }

  createBidderEscrow(payMBR: PayTxn): Address {
    verifyPayTxn(payMBR, {
      receiver: this.app.address,
      amount: { greaterThan: 400_000 },
    });

    const bidderPuppetAccount = sendMethodCall<typeof PuppetAddress.prototype.new>({
      onCompletion: OnCompletion.DeleteApplication,
      approvalProgram: PuppetAddress.approvalProgram(),
      clearStateProgram: PuppetAddress.clearProgram(),
    });

    sendPayment({
      receiver: bidderPuppetAccount,
      amount: 300_000,
    });

    this.doOptIn(this.poolToken.value, bidderPuppetAccount);
    this.doOptIn(this.assetA.value, bidderPuppetAccount);
    this.doOptIn(this.assetB.value, bidderPuppetAccount);

    this.biddersRegistry(this.txn.sender).value = bidderPuppetAccount;

    return bidderPuppetAccount;
  }

  /*   bid(lpAsset: AssetID, rounds: uint64, bid: uint64, start: uint64): void {
    // check if bid is set correctly;
    // check if the bid for the given starting round is winning;
  } */

  setNewFee(currentFee: uint64): void {
    verifyTxn(this.txn, {
      sender: this.poolManager.value,
    });
    assert(currentFee <= this.maxFee.value);
    this.currentFee.value = currentFee;
  }

  private doCreatePoolToken(aAsset: AssetID, bAsset: AssetID): AssetID {
    return sendAssetCreation({
      configAssetName: 'VLP-' + aAsset.unitName + '-' + bAsset.unitName,
      configAssetUnitName: 'vlp',
      configAssetTotal: TOTAL_SUPPLY,
      configAssetDecimals: 3,
      configAssetManager: this.app.address,
      configAssetReserve: this.app.address,
    });
  }

  private doAxfer(sender: Address, receiver: Address, asset: AssetID, amount: uint64): void {
    sendAssetTransfer({
      assetCloseTo: sender,
      assetReceiver: receiver,
      xferAsset: asset,
      assetAmount: amount,
    });
  }

  private doOptIn(asset: AssetID, address: Address): void {
    this.doAxfer(address, address, asset, 0);
  }

  private tokensToMintIntial(aAmount: uint64, bAmount: uint64): uint64 {
    return sqrt(aAmount * bAmount);
  }

  private tokensToMint(issued: uint64, aSupply: uint64, bSupply: uint64, aAmount: uint64, bAmount: uint64): uint64 {
    const aRatio = wideRatio([aAmount, SCALE], [aSupply]);
    const bRatio = wideRatio([bAmount, SCALE], [bSupply]);

    const ratio = aRatio < bRatio ? aRatio : bRatio;

    return wideRatio([ratio, issued], [SCALE]);
  }

  private computeRatio(): uint64 {
    return wideRatio(
      [this.app.address.assetBalance(this.assetA.value), SCALE],
      [this.app.address.assetBalance(this.assetB.value)]
    );
  }

  private tokensToBurn(issued: uint64, supply: uint64, amount: uint64): uint64 {
    return wideRatio([supply, amount], [issued]);
  }

  private tokensToSwap(inAmount: uint64, inSupply: uint64, outSupply: uint64): uint64 {
    const factor = SCALE;
    return wideRatio([inAmount, factor, outSupply], [inSupply * SCALE + inAmount * factor]);
  }

  private feeToCollect(amount: uint64): uint64 {
    return wideRatio([amount, this.currentFee.value], [SCALE]);
  }
}
