require("dotenv").config();

import {
  loadKeypair,
  MangoOrderSide,
  MangoPerpOrderType,
  MarginfiAccount,
  MarginfiAccountData,
  MarginfiClient,
  processTransaction,
  Wallet,
  ZoPerpOrderType,
} from "@mrgnlabs/marginfi-client";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  ZERO_I80F48,
  QUOTE_INDEX,
  ONE_I80F48,
  ZERO_BN,
} from "@blockworks-foundation/mango-client";
import { BigNumber } from "bignumber.js";

const connection = new Connection(process.env.RPC_ENDPOINT!, {
  commitment: "confirmed",
});
const wallet = new Wallet(
  process.env.WALLET_KEY
    ? Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.WALLET_KEY)))
    : loadKeypair(process.env.WALLET!)
);

(async function () {
  const marginClient = await MarginfiClient.fromEnv({ wallet, connection });

  const marginfiAccounts = await marginClient.getOwnMarginfiAccounts();
  console.log("Found %s accounts", marginfiAccounts.length);

  for (let marginfiAccount of marginfiAccounts) {
    console.log("Checking account %s", marginfiAccount.publicKey);
    await checkForActiveUtps(marginfiAccount);
    await marginfiAccount.reload();
    const { equity } = marginfiAccount.computeBalances();
    if (equity.gt(0.1)) {
      console.log("Withdrawing %s to wallet", equity);
      await marginfiAccount.withdraw(equity);
    }
  }

  console.log("Done");
})();

async function checkForActiveUtps(marginfiAccount: MarginfiAccount) {
  await marginfiAccount.reload();
  if (marginfiAccount.activeUtps.length > 0) {
    console.log("Marginfi account has active UTPs, closing...");
    await closeAllUTPs(marginfiAccount);
  }
}

async function closeAllUTPs(marginfiAccount: MarginfiAccount) {
  await marginfiAccount.reload();
  console.log("Closing all UTP accounts for %s", marginfiAccount.publicKey);

  // Close all UTP positions
  if (marginfiAccount.mango.isActive) {
    console.log("Marginfi account has active Mango, closing...");
    await closeMango(marginfiAccount);
  }

  if (marginfiAccount.zo.isActive) {
    console.log("Marginfi account has active 01, closing...");
    await closeZo(marginfiAccount);
  }
  // Close the UTP account
}

async function closeZo(marginfiAccount: MarginfiAccount) {
  console.log("Closing Zo Positions");

  const zoState = await marginfiAccount.zo.getZoState();
  const zoMargin = await marginfiAccount.zo.getZoMargin(zoState);

  /// Close open orders
  const marketSymbols = Object.keys(zoState.markets);

  console.log("Cancelling Open Orders");
  for (let sym of marketSymbols) {
    let oo = await zoMargin.getOpenOrdersInfoBySymbol(sym, false);
    let empty = !oo || (oo.coinOnAsks.isZero() && oo.coinOnBids.isZero());
    if (!empty) {
      await marginfiAccount.zo.cancelPerpOrder({ symbol: sym });
    }
  }

  /// Close positions
  console.log("Closing Positions");
  for (let position of zoMargin.positions) {
    if (position.coins.number === 0) {
      continue;
    }
    await zoState.loadMarkets();

    let closeDirectionLong = !position.isLong;
    let price;
    let market = await zoState.getMarketBySymbol(position.marketKey);

    if (closeDirectionLong) {
      let asks = await market.loadAsks(connection);
      price = [...asks.items(true)][0].price;
    } else {
      let bidsOrderbook = await market.loadBids(connection);
      let bids = [...bidsOrderbook.items(true)];
      price = bids[bids.length - 1].price;
    }

    console.log(
      "Closing position on %s %s @ %s",
      position.coins.number,
      position.marketKey,
      price
    );

    let oo = await zoMargin.getOpenOrdersInfoBySymbol(
      position.marketKey,
      false
    );
    if (!oo) {
      await marginfiAccount.zo.createPerpOpenOrders(position.marketKey);
    }
    await marginfiAccount.zo.placePerpOrder({
      symbol: position.marketKey,
      orderType: ZoPerpOrderType.ReduceOnlyIoc,
      isLong: closeDirectionLong,
      price: price,
      size: position.coins.number,
    });
  }

  /// Settle funds
  for (let symbol of marketSymbols) {
    let oo = await zoMargin.getOpenOrdersInfoBySymbol(symbol);

    if (!oo) {
      continue;
    }

    await marginfiAccount.zo.settleFunds(symbol);
  }

  const observation = await marginfiAccount.zo.observe();
  let withdrawableAmount = BigNumber.max(
    observation.freeCollateral.minus(0.1),
    0
  );

  if (withdrawableAmount.gte(0.1)) {
    console.log("Withdrawing %s from ZO", withdrawableAmount.toString());
    await marginfiAccount.zo.withdraw(withdrawableAmount);
  }

  console.log("Deactivating ZO");
  await marginfiAccount.zo.deactivate();
}

async function closeMango(marginfiAccount: MarginfiAccount) {
  console.log("Closing Mango positions");

  await closeMangoPositions(marginfiAccount);

  await withdrawFromMango(marginfiAccount);

  await marginfiAccount.mango.deactivate();
  console.log("Deactivating mango");
  await marginfiAccount.reload();
}

async function withdrawFromMango(marginfiAccount: MarginfiAccount) {
  console.log("Trying to withdraw from Mango");
  let observation = await marginfiAccount.mango.observe();
  let withdrawAmount = observation.freeCollateral.minus(0.000001);

  if (withdrawAmount.lte(0)) {
    return;
  }

  console.log("Withdrawing %d from Mango", withdrawAmount.toString());
  await marginfiAccount.mango.withdraw(withdrawAmount);
}

async function closeMangoPositions(marginfiAccount: MarginfiAccount) {
  const mangoUtp = marginfiAccount.mango;

  const mangoGroup = await mangoUtp.getMangoGroup();
  const mangoAccount = await mangoUtp.getMangoAccount(mangoGroup);

  await mangoAccount.reload(marginfiAccount.client.program.provider.connection);

  const perpMarkets = await Promise.all(
    mangoUtp.config.groupConfig.perpMarkets.map((perpMarket) => {
      return mangoGroup.loadPerpMarket(
        connection,
        perpMarket.marketIndex,
        perpMarket.baseDecimals,
        perpMarket.quoteDecimals
      );
    })
  );

  try {
    console.log("Closing positions");
    await mangoAccount.reload(connection, mangoGroup.dexProgramId);
    const cache = await mangoGroup.loadCache(connection);

    for (let i = 0; i < perpMarkets.length; i++) {
      const perpMarket = perpMarkets[i];
      const index = mangoGroup.getPerpMarketIndex(perpMarket.publicKey);
      const perpAccount = mangoAccount.perpAccounts[index];
      const groupIds = mangoUtp.config.groupConfig;

      if (perpMarket && perpAccount) {
        const openOrders = await perpMarket.loadOrdersForAccount(
          connection,
          mangoAccount
        );

        for (const oo of openOrders) {
          console.log("Canceling Perp Order %s", oo.orderId);
          await mangoUtp.cancelPerpOrder(perpMarket, oo.orderId, false);
        }

        const basePositionSize = Math.abs(
          perpMarket.baseLotsToNumber(perpAccount.basePosition)
        );
        const price = mangoGroup.getPrice(index, cache);

        if (basePositionSize != 0) {
          const side = perpAccount.basePosition.gt(ZERO_BN)
            ? MangoOrderSide.Ask
            : MangoOrderSide.Bid;
          const liquidationFee = mangoGroup.perpMarkets[index].liquidationFee;
          const orderPrice =
            side == MangoOrderSide.Ask
              ? price.mul(ONE_I80F48.sub(liquidationFee)).toNumber()
              : price.mul(ONE_I80F48.add(liquidationFee)).toNumber();

          console.log(
            `${side}ing ${basePositionSize} of ${groupIds?.perpMarkets[i].baseSymbol}-PERP for $${orderPrice}`
          );

          const ixw = await mangoUtp.makePlacePerpOrderIx(
            perpMarket,
            side,
            orderPrice,
            basePositionSize,
            {
              orderType: MangoPerpOrderType.Market,
              reduceOnly: true,
            }
          );

          await processTransaction(
            marginfiAccount.client.program.provider,
            new Transaction().add(
              ComputeBudgetProgram.requestUnits({
                units: 400_000,
                additionalFee: 0,
              }),
              ...ixw.instructions
            ),
            []
          );
        }

        await mangoAccount.reload(connection, mangoGroup.dexProgramId);
      }

      const rootBanks = await mangoGroup.loadRootBanks(connection);

      if (!perpAccount.quotePosition.eq(ZERO_I80F48)) {
        const quoteRootBank = rootBanks[QUOTE_INDEX];
        if (quoteRootBank) {
          console.log(
            "Settle %s-PERP, %s",
            groupIds?.perpMarkets[i].baseSymbol,
            perpAccount.quotePosition
          );
          const mangoClient = mangoUtp.getMangoClient();
          await mangoClient.settlePnl(
            mangoGroup,
            cache,
            mangoAccount,
            perpMarket,
            quoteRootBank,
            cache.priceCache[index].price,
            wallet.payer
          );

          await sleep(5_000);
        }
      }
    }
  } catch (err) {
    console.error("Error closing positions", err);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
