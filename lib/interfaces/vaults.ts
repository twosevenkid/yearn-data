import { Apy, yearn } from "..";

export type Vault = yearn.vault.Vault & {
  apy: Apy | null;
};

export type CachedToken = WithAssets<yearn.vault.Token>;

export type CachedVault = WithAssets<Vault> & {
  token: CachedToken;
  updated: number;
  tvl: number | null;
};

export type WithAssets<T> = T & {
  displayName: string;
  icon: string | null;
};
