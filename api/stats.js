const RPC_URL = "https://api.mainnet.abs.xyz";

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || "RPC error");
  }

  return data.result;
}

async function getBlock(number) {
  const hex = "0x" + number.toString(16);

  const block = await rpc(
    "eth_getBlockByNumber",
    [hex, false]
  );

  if (!block) return null;

  return {
    number: Number(BigInt(block.number)),
    timestamp: Number(BigInt(block.timestamp)) * 1000,
    transactions: Array.isArray(block.transactions)
      ? block.transactions.length
      : 0
  };
}

function getMinuteStart(time) {
  const date = new Date(time);
  date.setSeconds(0, 0);
  return date.getTime();
}

function getFiveMinuteStart(time) {
  const date = new Date(time);

  date.setMinutes(
    Math.floor(date.getMinutes() / 5) * 5,
    0,
    0
  );

  return date.getTime();
}

/*
  Find the first block whose timestamp
  is at or after targetTime.

  We first jump backwards, then use
  binary search.
*/

async function findFirstBlockAtOrAfter(
  targetTime,
  latestNumber
) {
  let upperNumber = latestNumber;

  let upperBlock =
    await getBlock(upperNumber);

  if (!upperBlock) {
    throw new Error("Latest block unavailable");
  }

  /*
    Jump backwards until we cross
    the target timestamp.
  */

  let step = 64;

  let lowerNumber = upperNumber;
  let lowerBlock = upperBlock;

  while (
    lowerNumber > 0 &&
    lowerBlock.timestamp >= targetTime
  ) {
    upperNumber = lowerNumber;

    const nextNumber =
      Math.max(
        0,
        lowerNumber - step
      );

    lowerNumber = nextNumber;

    lowerBlock =
      await getBlock(lowerNumber);

    if (!lowerBlock) {
      throw new Error(
        "Historical block unavailable"
      );
    }

    step *= 2;
  }

  /*
    Binary search between:
    lower = before target
    upper = at/after target
  */

  let left = lowerNumber;
  let right = upperNumber;

  while (left + 1 < right) {
    const middle =
      Math.floor(
        (left + right) / 2
      );

    const block =
      await getBlock(middle);

    if (!block) {
      throw new Error(
        "Block unavailable during search"
      );
    }

    if (
      block.timestamp <
      targetTime
    ) {
      left = middle;
    } else {
      right = middle;
    }
  }

  /*
    Genesis edge case.
  */

  const leftBlock =
    await getBlock(left);

  if (
    leftBlock &&
    leftBlock.timestamp >= targetTime
  ) {
    return left;
  }

  return right;
}

export default async function handler(req, res) {
  try {
    const now = Date.now();

    /*
      LAST COMPLETED MINUTE

      Example:
      now = 23:27:35

      interval =
      23:26:00 → 23:27:00
    */

    const currentMinuteStart =
      getMinuteStart(now);

    const lastMinuteStart =
      currentMinuteStart - 60_000;

    const lastMinuteEnd =
      currentMinuteStart;

    /*
      LAST COMPLETED FIXED 5 MINUTES

      Example:
      now = 23:27

      interval =
      23:20 → 23:25
    */

    const currentFiveStart =
      getFiveMinuteStart(now);

    const lastFiveStart =
      currentFiveStart - 300_000;

    const lastFiveEnd =
      currentFiveStart;

    /*
      Latest Abstract block
    */

    const latestHex =
      await rpc("eth_blockNumber");

    const latestNumber =
      Number(BigInt(latestHex));

    /*
      Find where the previous
      5-minute interval begins.
    */

    const firstBlock =
      await findFirstBlockAtOrAfter(
        lastFiveStart,
        latestNumber
      );

    let lastMinuteTransactions = 0;
    let lastFiveTransactions = 0;

    let scanned = 0;

    /*
      Safety ceiling.
    */

    const MAX_SCAN = 10000;

    for (
      let number = firstBlock;
      number <= latestNumber;
      number++
    ) {
      if (scanned >= MAX_SCAN) {
        throw new Error(
          "Block scan safety limit reached"
        );
      }

      const block =
        await getBlock(number);

      if (!block) {
        throw new Error(
          `Block ${number} unavailable`
        );
      }

      scanned++;

      /*
        LAST 5 MIN
    */

      if (
        block.timestamp >= lastFiveStart &&
        block.timestamp < lastFiveEnd
      ) {
        lastFiveTransactions +=
          block.transactions;
      }

      /*
        LAST 1 MIN
      */

      if (
        block.timestamp >= lastMinuteStart &&
        block.timestamp < lastMinuteEnd
      ) {
        lastMinuteTransactions +=
          block.transactions;
      }

      /*
        Both intervals are finished.

        Once block timestamp reaches
        the newest end boundary,
        we can stop scanning.
      */

      const finalEnd =
        Math.max(
          lastMinuteEnd,
          lastFiveEnd
        );

      if (
        block.timestamp >= finalEnd
      ) {
        break;
      }
    }

    /*
      Vercel edge cache.

      Multiple visitors can reuse
      the result instead of each
      triggering the entire scan.
    */

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=20, stale-while-revalidate=40"
    );

    return res.status(200).json({
      lastMinute: {
        transactions:
          lastMinuteTransactions,

        start:
          lastMinuteStart,

        end:
          lastMinuteEnd
      },

      lastFiveMinutes: {
        transactions:
          lastFiveTransactions,

        start:
          lastFiveStart,

        end:
          lastFiveEnd
      },

      latestBlock:
        latestNumber,

      generatedAt:
        Date.now()
    });

  } catch (error) {
    console.error(
      "Abstract stats error:",
      error
    );

    return res.status(500).json({
      error:
        "Could not calculate Abstract statistics."
    });
  }
}
