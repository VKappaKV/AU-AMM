import * as algokit from '@algorandfoundation/algokit-utils';
import algosdk from 'algosdk';
import { AmmFactory } from './clients/AMMClient';

if (!process.env.MNEMONIC) {
  throw new Error('No MNEMONIC in .env');
}
const account = algosdk.mnemonicToSecretKey(process.env.MNEMONIC);

(async () => {
  const factory = new AmmFactory({
    defaultSender: account.addr,
    defaultSigner: algosdk.makeBasicAccountTransactionSigner(account),
    algorand: algokit.AlgorandClient.testNet(),
  });

  const res = await factory.send.create.createApplication({ args: [] });
  console.log(res.result.appId);
})();
