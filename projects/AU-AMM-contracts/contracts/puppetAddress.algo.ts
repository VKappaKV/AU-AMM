import { Contract } from '@algorandfoundation/tealscript';

export class PuppetAddress extends Contract {
  /**
   * Create a new account, rekeying it to the caller application address
   * @returns New account address
   */
  @allow.create('DeleteApplication')
  new(): Address {
    sendPayment({
      receiver: this.app.address,
      amount: 0,
      rekeyTo: globals.callerApplicationAddress,
    });

    return this.app.address;
  }
}
