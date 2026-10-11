import { Keypair } from '@solana/web3.js';
import { identity, now } from './phoenix-orders';
import type { PhoenixDefenseFacts } from '../../server/protocol/phoenix/auto-defense-policy';

export function defenseFacts(): PhoenixDefenseFacts {
  const account = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey.toBase58();
  return {
    intent:{version:1,botId:'EXAMPLE-bot',ownerWallet:'EXAMPLE-owner',requestKey:'EXAMPLE-request',identity,accountAuthority:account,
      action:'repay',collateralMint:'EXAMPLE-collateral',accountLoanId:'EXAMPLE-account-loan',accountVenueId:1,
      botLoanId:'EXAMPLE-bot-loan',botVenueId:2,amountRaw:'10000000',collateralRaw:'0',targetLtv:0.5,
      consent:{accountCollateral:true,reserve:true,deployBorrowed:false},reserveRaw:'10000000',measurementHash:null},
    snapshot:{observedAt:now,oracleObservedAt:now,reference:'EXAMPLE-lender-read',authority:identity.authorityWalletAddress,
      accountAuthority:account,collateralMint:'EXAMPLE-collateral',accountLoanId:'EXAMPLE-account-loan',accountVenueId:1,
      botLoanId:'EXAMPLE-bot-loan',botVenueId:2,debtRaw:'90000000',collateralRaw:'100000000',walletUsdcRaw:'50000000',
      queuedUsdcRaw:'0',complete:true,accountCarveAllowed:true,botHealthAllowed:true,measured:null,queueCostRaw:null,expectedQueueSeconds:null},
    health:{borrowPositionId:'EXAMPLE-bot-loan',venuePositionId:2,collateralAssetKey:'EXAMPLE',collateralMint:'EXAMPLE-collateral',
      status:'available',collateralValueUsd:100,debtUsd:90,ltv:0.9,healthFactor:1.1,liquidatable:false,band:'urgent',
      liveCollateralRaw:'100000000',liveDebtRaw:'90000000'},
    suggestion:{suggestedCollateralRaw:80000000n,suggestedCollateralTokens:80,suggestedCollateralUsd:80,targetLtv:0.5},
    autoCollateralTopUp:true,autoRepayEnabled:true,heldAccountCollateralRaw:'80000000',collateralPriceUsd:1,collateralDecimals:6,
    reserveAuthorized:true,maxTopupRaw:'20000000',maxRepayRaw:'30000000',maxAgeMs:15000,previousAttemptAt:null,
  };
}
