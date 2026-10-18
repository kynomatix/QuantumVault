import {describe,expect,it} from 'vitest';
import {requestDigest,canonicalRequest} from '../../server/grid-bot/launch-storage';
import {requestDigest as sharedDigest} from '../../server/grid-bot/request-digest';
import {cycleRequestDigest} from '../../server/grid-bot/cycle-history';

// Captured with origin/main's v1 exact-request encoder before extraction.
const v1Request={
  "kind": "limit",
  "botId": "EXAMPLE_BOT",
  "account": "EXAMPLE_ACCOUNT",
  "masterAccount": "EXAMPLE_MASTER",
  "path": "/orders/create",
  "operationType": "create_order",
  "timestamp": 1800000000000,
  "expiryMs": 5000,
  "data": {
    "symbol": "BTC",
    "price": "90.00000000",
    "amount": "0.10000000",
    "side": "bid",
    "reduce_only": false,
    "tif": "ALO",
    "client_order_id": "EXAMPLE_CLIENT_ORDER"
  },
  "authority": {
    "policy": {
      "policyVersion": "1.0.0",
      "levels": [
        {
          "ordinal": 1,
          "size": "0.10000000",
          "price": "90.00000000"
        }
      ]
    },
    "levelId": "EXAMPLE_LEVEL",
    "levelAttempt": 0
  }
};
const expectedSha256='6385ed2c8a47863a236f34808b8be2303ada5c8f1f845ac02089de5dfdf33f70';
describe('shared exact request digest',()=>{
  it('preserves the fixed v1 request bytes and uses one digest implementation',()=>{
    expect(requestDigest(v1Request)).toBe(expectedSha256);
    expect(requestDigest).toBe(sharedDigest);expect(cycleRequestDigest).toBe(sharedDigest);
    expect(canonicalRequest({...v1Request,data:{...v1Request.data}})).toBe(canonicalRequest(v1Request));
  });
});
