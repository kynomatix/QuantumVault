import { describe, it, expect, afterEach } from "vitest";
import {
  isBorrowOpenToAll,
  isBorrowAllowlisted,
  isBorrowEligibleWallet,
  isBorrowOwnerWallet,
  BORROW_OPEN_TO_ALL,
} from "../../server/vault/borrow-allowlist";

// Borrowing is launched PUBLICLY: any connected wallet may use the borrow money
// path in EVERY environment (development AND the live production site). These
// tests pin that the wallet whitelist is fully open while BORROW_OPEN_TO_ALL is
// true, and that the owner-wallet predicate still resolves (used when borrowing
// is re-closed to a private beta).

const SAVED = {
  NODE_ENV: process.env.NODE_ENV,
  REPLIT_DEPLOYMENT_DOMAIN: process.env.REPLIT_DEPLOYMENT_DOMAIN,
  BORROW_OWNER_WALLET: process.env.BORROW_OWNER_WALLET,
};

function setEnv(node: string | undefined, deployDomain?: string, owner?: string) {
  if (node === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = node;
  if (deployDomain === undefined) delete process.env.REPLIT_DEPLOYMENT_DOMAIN;
  else process.env.REPLIT_DEPLOYMENT_DOMAIN = deployDomain;
  if (owner === undefined) delete process.env.BORROW_OWNER_WALLET;
  else process.env.BORROW_OWNER_WALLET = owner;
}

const RANDOM_WALLET = "9aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcdEF";
const OTHER_WALLET = "SomeOtherWalletAddress1111111111111111111";

describe("borrow eligibility gate (open to all)", () => {
  afterEach(() => {
    setEnv(SAVED.NODE_ENV, SAVED.REPLIT_DEPLOYMENT_DOMAIN, SAVED.BORROW_OWNER_WALLET);
  });

  it("is launched open to all wallets", () => {
    expect(BORROW_OPEN_TO_ALL).toBe(true);
    expect(isBorrowOpenToAll()).toBe(true);
  });

  describe("isBorrowAllowlisted — any wallet, any environment", () => {
    it("allows any wallet in development", () => {
      setEnv("development");
      expect(isBorrowAllowlisted(RANDOM_WALLET)).toBe(true);
    });

    it("allows any wallet on the live production site", () => {
      setEnv("production", "quantumvault.replit.app");
      expect(isBorrowAllowlisted(RANDOM_WALLET)).toBe(true);
    });

    it("allows any wallet under tests / unset env", () => {
      setEnv(undefined);
      expect(isBorrowAllowlisted(OTHER_WALLET)).toBe(true);
    });
  });

  describe("isBorrowEligibleWallet — any wallet, any environment", () => {
    it("allows any wallet in development", () => {
      setEnv("development");
      expect(isBorrowEligibleWallet(RANDOM_WALLET)).toBe(true);
    });

    it("allows any wallet on the live production site", () => {
      setEnv("production", "quantumvault.replit.app");
      expect(isBorrowEligibleWallet(RANDOM_WALLET)).toBe(true);
      expect(isBorrowEligibleWallet(OTHER_WALLET)).toBe(true);
    });
  });

  describe("isBorrowOwnerWallet — still resolves (used when re-closed to a beta)", () => {
    it("recognizes the configured owner wallet and rejects others", () => {
      setEnv("production", undefined, RANDOM_WALLET);
      expect(isBorrowOwnerWallet(RANDOM_WALLET)).toBe(true);
      expect(isBorrowOwnerWallet(OTHER_WALLET)).toBe(false);
    });

    it("treats no wallet as owner when BORROW_OWNER_WALLET is unset", () => {
      setEnv("production");
      expect(isBorrowOwnerWallet(RANDOM_WALLET)).toBe(false);
    });
  });
});
