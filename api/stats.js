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

function minuteStart(timestamp) {
  const d = new Date(timestamp);
  d.setSeconds(0, 0);
  return d.getTime();
}

function fiveMinuteStart(timestamp) {
  const d = new Date(timestamp);

  d.setMinutes(
    Math.floor(d.getMinutes() / 5) * 5,
    0,
    0
  );

  return d.getTime();
}

/*
  Find approximately where a timestamp is
  without scanning every previous block.

  We first jump backwards quickly and then
  binary-search the remaining range.
*/
async function findFirstBlockAtOrAfter(targetTime, latestNumber) {
  let high = latestNumber;

  const latest = await getBlock(high);

  if (!latest) {
    throw new Error("Could not read latest block");
  }

  if (latest.timestamp < targetTime) {
    return high + 1;
  }

  let low = high;
  let step = 64;

  while (low > 0) {
    const candidateNumber = Math.max(0, low - step);
    const candidate = await getBlock(candidateNumber);

    if (!candidate) {
      throw new Error("Could not read historical block");
    }

    if (candidate.timestamp < targetTime) {
      low = candidateNumber;
      break;
    }

    high = candidateNumber;
    low = candidateNumber;

    step *= 2;
  }

  let left = low;
  let right = high;

  /*
    If the jump loop reached genesis-ish territory,
    make sure the bounds still work.
  */
  const leftBlock = await getBlock(left);

  if (leftBlock && leftBlock.timestamp >= targetTime) {
    left = 0;
  }

  while (left + 1 < right) {
    const mid = Math.floor((left + right) / 2);

    const block = await getBlock(mid);

    if (!block) {
      throw new Error("Could not binary-search blocks");
    }

    if (block.timestamp < targetTime) {
      left = mid;
    } else {
      right = mid;
    }
  }

  const leftCheck = await getBlock(left);

  if (leftCheck && leftCheck.timestamp >= targetTime) {
    return left;
  }

  return right;
}

function formatPeriod(start, end) {
  return {
    start,
    end
  };
}

export default async function handler(req, res) {
  try {
    /*
      Use server time only to define the finished
      wall-clock intervals.

      Blockchain timestamps determine which blocks
      actually belong to those intervals.
    */

    const now = Date.now();

    const thisMinute = minuteStart(now);

    const lastMinuteStart = thisMinute - 60_000;
    const lastMinuteEnd = thisMinute;

    const thisFive = fiveMinuteStart(now);

    const lastFiveStart = thisFive - 300_000;
    const lastFiveEnd = thisFive;

    const latestHex = await rpc("eth_blockNumber");
    const latestNumber = Number(BigInt(latestHex));

    /*
      Find first block belonging to the older
      boundary we need: beginning of LAST 5 MIN.
    */

    const firstNumber =
      await findFirstBlockAtOrAfter(
        lastFiveStart,
        latestNumber
      );

    let lastMinuteTx = 0;
    let lastFiveTx = 0;

    let scannedBlocks = 0;

    /*
      Safety ceiling. We stop naturally as soon as
      block timestamp reaches the end of the last
      completed minute / five-minute window.
    */
    const MAX_SCAN = 5000;

    for (
      let number = firstNumber;
      number <= latestNumber && scannedBlocks < MAX_SCAN;
      number++
    ) {
      const block = await getBlock(number);

      if (!block) {
        throw new Error(`Could not read block ${number}`);
      }

      scannedBlocks++;

      /*
        Once we have crossed both finished windows,
        there is nothing else to count.
      */
      if (
        block.timestamp >= lastMinuteEnd &&
        block.timestamp >= lastFiveEnd
      ) {
        break;
      }

      if (
        block.timestamp >= lastFiveStart &&
        block.timestamp < lastFiveEnd
      ) {
        lastFiveTx += block.transactions;
      }

      if (
        block.timestamp >= lastMinuteStart &&
        block.timestamp < lastMinuteEnd
      ) {
        lastMinuteTx += block.transactions;
      }
    }

    res.setHeader(
      "Cache-Control",
      "s-maxage=15, stale-while-revalidate=45"
    );

    return res.status(200).json({
      lastMinute: {
        transactions: lastMinuteTx,
        ...formatPeriod(
          lastMinuteStart,
          lastMinuteEnd
        )
      },

      lastFiveMinutes: {
        transactions: lastFiveTx,
        ...formatPeriod(
          lastFiveStart,
          lastFiveEnd
        )
      },

      latestBlock: latestNumber,

      generatedAt: Date.now()
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Could not calculate Abstract activity."
    });
  }
}
