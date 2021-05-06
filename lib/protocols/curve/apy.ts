import {
  CurveGaugeContract__factory,
  CurveGaugeControllerContract__factory,
  CurveMultiRewards__factory,
  CurveRegistryContract__factory,
  CurveStakingRewards__factory,
} from "@contracts/index";
import { Context } from "@data/context";
import { price } from "@protocols/coingecko";
import { Apy, calculateFromPps } from "@protocols/common/apy";
import { Vault } from "@protocols/yearn/vault/interfaces";
import { BigNumber, toBigNumber } from "@utils/bignumber";
import { estimateBlockPrecise, fetchLatestBlock } from "@utils/block";
import { NullAddress } from "@utils/constants";
import { seconds, unix } from "@utils/time";

import { CurveRegistryAddress, getPool, getUnderlyingCoins } from "./registry";

const CrvAddress = "0xD533a949740bb3306d119CC777fa900bA034cd52";

const WbtcAddress = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const RenBtcAddress = "0xEB4C2781e4ebA804CE9a9803C67d0893436bB27D";
const SBtcAddress = "0xfE18be6b3Bd88A2D2A7f928d00292E7a9963CfC6";
const SEthAddress = "0x5e74C9036fb86BD7eCdcb084a0673EFc32eA31cb";

const EthAddress = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const StEthAddress = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
const WethAddress = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const YearnVeCrvvoterAddress = "0xF147b8125d2ef93FB6965Db97D6746952a133934";

const MaxBoost = 2.5;
const InverseMaxBoost = new BigNumber(1 / MaxBoost);
const SecondsInYear = new BigNumber(seconds("1 year"));
const FeeDenominator = 1e4;
const EthConstant = 1e18;

const BtcLikeAddresses = [RenBtcAddress, WbtcAddress, SBtcAddress];
const EthLikeAddresses = [SEthAddress, EthAddress, WethAddress, StEthAddress];

export async function calculatePoolApr(
  vault: Vault,
  ctx: Context
): Promise<number | null> {
  const lpToken = vault.token.address;
  const registry = CurveRegistryContract__factory.connect(
    CurveRegistryAddress,
    ctx.provider
  );
  const latest = await fetchLatestBlock(ctx);
  const oneDay = await estimateBlockPrecise(
    latest.timestamp - seconds("1 day"),
    ctx
  );

  const poolAprSamples = await calculateFromPps(
    latest.block,
    oneDay,
    { oneDaySample: oneDay },
    (overrides) => registry.get_virtual_price_from_lp_token(lpToken, overrides)
  );
  const poolApr = poolAprSamples.oneDaySample;
  return poolApr;
}

export async function calculateMultiRewards(
  rewardsAddress: string,
  poolVirtualPrice: BigNumber,
  priceOfBaseAsset: { usd: number },
  ctx: Context
): Promise<BigNumber> {
  const multiRewards = CurveMultiRewards__factory.connect(
    rewardsAddress,
    ctx.provider
  );

  let i = 0;
  let tokenRewardsApr = new BigNumber(0);
  let rewardTokenAddress = await multiRewards.rewardTokens(0);

  const stakingRewardsTotalSupply = await multiRewards
    .totalSupply()
    .then((val) => toBigNumber(val))
    .catch(() => toBigNumber(0));

  while (rewardTokenAddress !== NullAddress) {
    try {
      rewardTokenAddress = await multiRewards.rewardTokens(i++);
      if (rewardTokenAddress === NullAddress) break;
      const rewardData = await multiRewards.rewardData(rewardTokenAddress);

      if (rewardData.periodFinish.lt(unix())) {
        continue;
      }

      const stakingRewardsRate = await multiRewards
        .rewardData(rewardTokenAddress)
        .then((val) => toBigNumber(val.rewardRate).div(EthConstant))
        .catch(() => 0);

      const priceOfRewardAsset = (await price(rewardTokenAddress, ["usd"])) ?? {
        usd: 0,
      };
      const tokenRewardApr = SecondsInYear.times(stakingRewardsRate)
        .times(priceOfRewardAsset.usd)
        .div(
          poolVirtualPrice
            .div(EthConstant)
            .times(stakingRewardsTotalSupply)
            .div(EthConstant)
            .times(priceOfBaseAsset.usd)
        );

      tokenRewardsApr = tokenRewardsApr.plus(tokenRewardApr);
    } catch {
      break;
    }
  }

  return tokenRewardsApr;
}

export async function calculateRewards(
  rewardsAddress: string,
  poolVirtualPrice: BigNumber,
  priceOfBaseAsset: { usd: number },
  ctx: Context
): Promise<BigNumber> {
  const stakingRewards = CurveStakingRewards__factory.connect(
    rewardsAddress,
    ctx.provider
  );

  let periodFinish: BigNumber;
  try {
    periodFinish = await stakingRewards.periodFinish().then(toBigNumber);
  } catch {
    // ... then it's a multi-reward contract
    return await calculateMultiRewards(
      rewardsAddress,
      poolVirtualPrice,
      priceOfBaseAsset,
      ctx
    );
  }

  if (periodFinish.lt(unix())) {
    return new BigNumber(0);
  }

  const stakingRewardsRewardsTokenAddress = await stakingRewards
    .rewardsToken()
    .catch(() => null);

  const stakingRewardsRewardTokenAddress = await stakingRewards
    .rewardToken()
    .catch(() => null);

  const stakingRewardsSnxAddress = await stakingRewards.snx().catch(() => null);

  const stakingRewardsRate = await stakingRewards
    .rewardRate()
    .then((val) => toBigNumber(val))
    .catch(() => toBigNumber(0));

  const stakingRewardsTotalSupply = await stakingRewards
    .totalSupply()
    .then((val) => toBigNumber(val))
    .catch(() => toBigNumber(0));

  const rewardTokenAddress =
    stakingRewardsRewardTokenAddress ??
    stakingRewardsRewardsTokenAddress ??
    stakingRewardsSnxAddress;

  const priceOfRewardAsset = (rewardTokenAddress &&
    (await price(rewardTokenAddress, ["usd"]))) || { usd: 0 };

  const singleRewardToken = priceOfRewardAsset.usd && stakingRewardsRate;

  if (singleRewardToken) {
    // Single rewards token
    return SecondsInYear.times(stakingRewardsRate.div(EthConstant))
      .times(priceOfRewardAsset.usd)
      .div(
        poolVirtualPrice
          .div(EthConstant)
          .times(stakingRewardsTotalSupply.div(EthConstant))
          .times(priceOfBaseAsset.usd)
      );
  } else {
    try {
      // Multiple reward tokens
      let i = 0;
      let rewardTokenAddress = await stakingRewards.rewardTokens(i);
      let tokenRewardsApr = new BigNumber(0);
      while (rewardTokenAddress !== NullAddress) {
        const stakingRewardsRate = await stakingRewards
          .rewardData(rewardTokenAddress)
          .then((val) => toBigNumber(val.rewardRate).div(EthConstant))
          .catch(() => 0);
        const priceOfRewardAsset = (await price(rewardTokenAddress, [
          "usd",
        ])) ?? { usd: 0 };
        const tokenRewardApr = SecondsInYear.times(stakingRewardsRate)
          .times(priceOfRewardAsset.usd)
          .div(
            poolVirtualPrice
              .div(EthConstant)
              .times(stakingRewardsTotalSupply)
              .div(EthConstant)
              .times(priceOfBaseAsset.usd)
          );
        rewardTokenAddress = await stakingRewards
          .rewardTokens(++i)
          .catch(() => NullAddress);
        tokenRewardsApr = tokenRewardsApr.plus(tokenRewardApr);
      }
      return tokenRewardsApr;
    } catch {
      return new BigNumber(0);
    }
  }
}

export async function calculateApy(vault: Vault, ctx: Context): Promise<Apy> {
  const lpToken = vault.token.address;
  const registry = CurveRegistryContract__factory.connect(
    CurveRegistryAddress,
    ctx.provider
  );
  const poolAddress = await getPool(lpToken, ctx);
  const gauges = await registry.get_gauges(poolAddress);
  let gaugeAddress = gauges[0][0]; // first gauge

  // FIXME: crvUSDP doesn't have a gauge connected in the registry
  if (vault.address === "0x1B5eb1173D2Bf770e50F10410C9a96F7a8eB6e75") {
    gaugeAddress = "0x055be5DDB7A925BfEF3417FC157f53CA77cA7222";
  }

  const gauge = CurveGaugeContract__factory.connect(gaugeAddress, ctx.provider);
  const gaugeControllerAddress = await gauge.controller();
  const gaugeController = CurveGaugeControllerContract__factory.connect(
    gaugeControllerAddress,
    ctx.provider
  );

  const gaugeWorkingSupply = toBigNumber(await gauge.working_supply());
  const gaugeRelativeWeight = toBigNumber(
    await gaugeController.gauge_relative_weight(gaugeAddress)
  );
  const gaugeInflationRate = toBigNumber(await gauge.inflation_rate());
  const poolVirtualPrice = toBigNumber(
    await registry.get_virtual_price_from_lp_token(lpToken)
  );

  const underlyingCoins = await getUnderlyingCoins(lpToken, ctx);
  const firstUnderlyingCoinAddress = underlyingCoins[0];

  let btcMatch = false;
  let ethMatch = false;
  underlyingCoins.every((tokenAddress) => {
    btcMatch = BtcLikeAddresses.includes(tokenAddress);
    ethMatch = EthLikeAddresses.includes(tokenAddress);
    return !(btcMatch || ethMatch);
  });

  let priceOfBaseAsset;
  if (btcMatch) {
    priceOfBaseAsset = await price(WbtcAddress, ["usd"]);
  } else if (ethMatch) {
    priceOfBaseAsset = await price(WethAddress, ["usd"]);
  } else {
    priceOfBaseAsset = await price(firstUnderlyingCoinAddress, ["usd"]);
    priceOfBaseAsset = priceOfBaseAsset ?? { usd: 1 };
  }

  const priceOfCrv = await price(CrvAddress, ["usd"]);

  const yearnWorkingBalance = toBigNumber(
    await gauge.working_balances(YearnVeCrvvoterAddress)
  );
  const yearnGaugeBalance = toBigNumber(
    await gauge.balanceOf(YearnVeCrvvoterAddress)
  );

  const baseApr = gaugeInflationRate
    .times(gaugeRelativeWeight)
    .times(SecondsInYear.div(gaugeWorkingSupply))
    .times(InverseMaxBoost.div(poolVirtualPrice))
    .times(priceOfCrv.usd)
    .div(priceOfBaseAsset.usd);

  let currentBoost: BigNumber;

  if (yearnGaugeBalance.isGreaterThan(0)) {
    currentBoost = yearnWorkingBalance.div(
      InverseMaxBoost.times(yearnGaugeBalance)
    );
    if (currentBoost.isNaN()) {
      currentBoost = new BigNumber(1);
    }
  } else {
    currentBoost = new BigNumber(MaxBoost);
  }

  // FIXME: The HBTC v1 vault is currently still earning yield, but it is no longer boosted.
  if (vault.address === "0x46AFc2dfBd1ea0c0760CAD8262A5838e803A37e5") {
    currentBoost = new BigNumber(1);
  }

  const rewardAddress = await gauge.reward_contract().catch(() => null);

  let tokenRewardsApr = new BigNumber(0);

  if (rewardAddress && rewardAddress !== NullAddress) {
    tokenRewardsApr = await calculateRewards(
      rewardAddress,
      poolVirtualPrice,
      priceOfBaseAsset,
      ctx
    );
  }

  const compoundingEvents = 52; // TODO: investigate

  const poolApr = new BigNumber((await calculatePoolApr(vault, ctx)) ?? 0);
  let poolApy = poolApr.div(365).plus(1).pow(365).minus(1);

  // FIXME: crvANKR's pool apy going crazy
  if (vault.address === "0xE625F5923303f1CE7A43ACFEFd11fd12f30DbcA4") {
    poolApy = new BigNumber(0);
  }

  const boostedApr = baseApr.times(currentBoost);

  let keepCrv: number, totalPerformanceFee: number, managementFee: number;
  if (vault.type === "v1") {
    // v1
    keepCrv = (vault.fees.special.keepCrv ?? 0) / FeeDenominator;
    managementFee = 0;
    totalPerformanceFee = vault.fees.general.performanceFee / FeeDenominator;
  } else {
    // v2
    keepCrv = (vault.fees.special.keepCrv ?? 0) / FeeDenominator;
    managementFee = vault.fees.general.managementFee / FeeDenominator;
    totalPerformanceFee = vault.fees.general.performanceFee / FeeDenominator;
  }

  const grossFarmedApy = boostedApr
    .times(keepCrv)
    .plus(
      boostedApr
        .times(1 - keepCrv)
        .plus(tokenRewardsApr)
        .div(compoundingEvents)
        .plus(1)
        .pow(compoundingEvents)
    )
    .minus(1);

  const totalApy = grossFarmedApy.plus(1).times(poolApy.plus(1)).minus(1);

  const netCurveApr = boostedApr
    .times(1 - keepCrv)
    .plus(tokenRewardsApr)
    .times(1 - totalPerformanceFee)
    .minus(managementFee);

  const netFarmedApy = netCurveApr
    .div(compoundingEvents)
    .plus(1)
    .pow(compoundingEvents)
    .minus(1);

  const netCurveApy = netFarmedApy.plus(1).times(poolApy.plus(1)).minus(1);

  const data = {
    currentBoost: currentBoost.toNumber(),
    totalApy: totalApy.toNumber(),
    poolApy: poolApy.toNumber(),
    boostedApr: boostedApr.toNumber(),
    baseApr: baseApr.toNumber(),
    netApy: netCurveApy.toNumber(),
    tokenRewardsApr: tokenRewardsApr.toNumber(),
  };

  const apy = {
    recommended: netCurveApy.toNumber() || 0,
    type: "curve",
    composite: true,
    description: "Pool APY + Boosted CRV APY",
    data,
  };

  return apy;
}
