import { describe, it, expect, afterEach } from "vitest";
import {
  isBorrowGateBypassedForDev,
  isBorrowAllowlisted,
  isBorrowEligibleWallet,
  isBorrowOwnerWallet,
} from "../../server/vault/borrow-allowlist";

// These gate the borrow MONEY path. The dev bypass must open borrowing for any
// connected wallet ONLY in the development environment, and must stay fully
// closed in production (the live site) and under tests.

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

describe("borrow dev-bypass gate (money-safety)", () => {
  afterEach(() => {
    setEnv(SAVED.NODE_ENV, SAVED.REPLIT_DEPLOYMENT_DOMAIN, SAVED.BORROW_OWNER_WALLET);
  });

  describe("isBorrowGateBypassedForDev", () => {
    it("is true ONLY in development with no deployment domain", () => {
      setEnv("development");
      expect(isBorrowGateBypassedForDev()).toBe(true);
    });

    it("is false in development when a Replit deployment domain is present", () => {
      setEnv("development", "quantumvault.replit.app");
      expect(isBorrowGateBypassedForDev()).toBe(false);
    });

    it("is false in production (the live site stays gated)", () => {
      setEnv("production");
      expect(isBorrowGateBypassedForDev()).toBe(false);
    });

    it("is false in production even without a deployment domain", () => {
      setEnv("production", undefined);
      expect(isBorrowGateBypassedForDev()).toBe(false);
    });

    it("is false under tests (NODE_ENV=test) — deterministic gating preserved", () => {
      setEnv("test");
      expect(isBorrowGateBypassedForDev()).toBe(false);
    });

    it("is false when NODE_ENV is unset (fail closed)", () => {
      setEnv(undefined);
      expect(isBorrowGateBypassedForDev()).toBe(false);
    });
  });

  describe("isBorrowAllowlisted", () => {
    it("treats any wallet as allowlisted in dev", () => {
      setEnv("development");
      expect(isBorrowAllowlisted(RANDOM_WALLET)).toBe(true);
    });

    it("denies an un-allowlisted wallet in production (beta list empty)", () => {
      setEnv("production");
      expect(isBorrowAllowlisted(RANDOM_WALLET)).toBe(false);
    });
  });

  describe("isBorrowEligibleWallet", () => {
    it("allows any wallet in dev", () => {
      setEnv("development");
      expect(isBorrowEligibleWallet(RANDOM_WALLET)).toBe(true);
    });

    it("denies a non-owner wallet in production with no owner configured", () => {
      setEnv("production");
      expect(isBorrowEligibleWallet(RANDOM_WALLET)).toBe(false);
    });

    it("allows the owner wallet in production, denies others", () => {
      setEnv("production", undefined, RANDOM_WALLET);
      expect(isBorrowOwnerWallet(RANDOM_WALLET)).toBe(true);
      expect(isBorrowEligibleWallet(RANDOM_WALLET)).toBe(true);
      expect(isBorrowEligibleWallet(OTHER_WALLET)).toBe(false);
    });
  });
});
