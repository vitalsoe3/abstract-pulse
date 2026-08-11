const RPC_URL = "https://api.mainnet.abs.xyz";

const REDIS_URL =
  process.env.STORAGE_KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  "";

const REDIS_TOKEN =
  process.env.STORAGE_KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  "";

const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 300_000;
const DAY_MS = 86_400_000;

const HISTORY_DAYS = 7;

/*
  Conservative historical backfill.
  QStash calls this every 2 minutes.
*/
const BACKFILL_BLOCKS_PER_REFRESH = 400;
const BLOCK_FETCH_CONCURRENCY = 8;

/*
  New namespace.

  Old partial backfill data is completely ignored.
*/
const PREFIX = "abstract:v2";


/* =========================
   RPC
========================= */

async function rpc(method, params = []) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      10_000
    );

  try {
    const response =
      await fetch(
        RPC_URL,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              jsonrpc: "2.0",
              id:
                Math.floor(
                  Math.random() *
                  1_000_000_000
                ),
              method,
              params
            }),

          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      throw new Error(
        `RPC HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (data.error) {
      throw new Error(
        data.error.message ||
        "RPC error"
      );
    }

    if (
      typeof data.result ===
      "undefined"
    ) {
      throw new Error(
        "RPC returned no result"
      );
    }

    return data.result;

  } finally {
    clearTimeout(timeout);
  }
}


async function getBlock(number) {
  const hex =
    "0x" +
    number.toString(16);

  const block =
    await rpc(
      "eth_getBlockByNumber",
      [
        hex,
        false
      ]
    );

  if (!block) {
    return null;
  }

  return {
    number:
      Number(
        BigInt(block.number)
      ),

    timestamp:
      Number(
        BigInt(block.timestamp)
      ) * 1000,

    transactions:
      Array.isArray(
        block.transactions
      )
        ? block.transactions.length
        : 0
  };
}


/* =========================
   REDIS
========================= */

function redisAvailable() {
  return Boolean(
    REDIS_URL &&
    REDIS_TOKEN
  );
}


async function redisCommand(command) {
  if (!redisAvailable()) {
    return null;
  }

  const response =
    await fetch(
      REDIS_URL,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${REDIS_TOKEN}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(command)
      }
    );

  if (!response.ok) {
    throw new Error(
      `Redis HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (
    data &&
    data.error
  ) {
    throw new Error(
      data.error
    );
  }

  return data
    ? data.result
    : null;
}


/*
  Upstash REST pipeline.

  Multiple Redis commands travel in
  a single HTTP request.
*/
async function redisPipeline(
  commands
) {
  if (
    !redisAvailable() ||
    !Array.isArray(commands) ||
    commands.length === 0
  ) {
    return [];
  }

  const url =
    `${REDIS_URL.replace(/\/$/, "")}/pipeline`;

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${REDIS_TOKEN}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(
            commands
          )
      }
    );

  if (!response.ok) {
    throw new Error(
      `Redis pipeline HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (!Array.isArray(data)) {
    throw new Error(
      "Invalid Redis pipeline response"
    );
  }

  return data;
}


/* =========================
   TIME HELPERS
========================= */

function getMinuteStart(time) {
  return (
    Math.floor(
      time /
      MINUTE_MS
    ) *
    MINUTE_MS
  );
}


function getFiveMinuteStart(
  time
) {
  return (
    Math.floor(
      time /
      FIVE_MINUTES_MS
    ) *
    FIVE_MINUTES_MS
  );
}


function getUtcDayStart(time) {
  const date =
    new Date(time);

  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );
}


function dayKeyFromStart(
  dayStart
) {
  return new Date(
    dayStart
  )
    .toISOString()
    .slice(0, 10);
}


function minuteIndexInDay(
  minuteStart
) {
  const dayStart =
    getUtcDayStart(
      minuteStart
    );

  return Math.floor(
    (
      minuteStart -
      dayStart
    ) /
    MINUTE_MS
  );
}


/* =========================
   REDIS KEYS
========================= */

function minuteHashKey(
  dayKey
) {
  return (
    `${PREFIX}:minutes:${dayKey}`
  );
}


function daySummaryKey(
  dayKey
) {
  return (
    `${PREFIX}:day:${dayKey}`
  );
}


function liveMinuteKey(
  start
) {
  return (
    `${PREFIX}:live:minute:${start}`
  );
}


function liveFiveKey(
  start
) {
  return (
    `${PREFIX}:live:five:${start}`
  );
}


const CURSOR_BLOCK_KEY =
  `${PREFIX}:backfill:cursorBlock`;

const PROCESSED_THROUGH_KEY =
  `${PREFIX}:backfill:processedThrough`;


/* =========================
   BLOCK SEARCH
========================= */

async function findFirstBlockAtOrAfter(
  targetTime,
  latestNumber
) {
  let upperNumber =
    latestNumber;

  let upperBlock =
    await getBlock(
      upperNumber
    );

  if (!upperBlock) {
    throw new Error(
      "Latest block unavailable"
    );
  }

  if (
    upperBlock.timestamp <
    targetTime
  ) {
    return latestNumber + 1;
  }

  let step = 64;

  let lowerNumber =
    upperNumber;

  let lowerBlock =
    upperBlock;

  while (
    lowerNumber > 0 &&
    lowerBlock.timestamp >=
      targetTime
  ) {
    upperNumber =
      lowerNumber;

    lowerNumber =
      Math.max(
        0,
        lowerNumber - step
      );

    lowerBlock =
      await getBlock(
        lowerNumber
      );

    if (!lowerBlock) {
      throw new Error(
        "Historical block unavailable"
      );
    }

    step *= 2;
  }

  let left =
    lowerNumber;

  let right =
    upperNumber;

  while (
    left + 1 <
    right
  ) {
    const middle =
      Math.floor(
        (
          left +
          right
        ) /
        2
      );

    const block =
      await getBlock(
        middle
      );

    if (!block) {
      throw new Error(
        "Block unavailable during search"
      );
    }

    if (
      block.timestamp <
      targetTime
    ) {
      left =
        middle;
    } else {
      right =
        middle;
    }
  }

  const leftBlock =
    await getBlock(
      left
    );

  if (
    leftBlock &&
    leftBlock.timestamp >=
      targetTime
  ) {
    return left;
  }

  return right;
}


/* =========================
   LIVE INTERVAL
========================= */

async function calculateInterval(
  start,
  end,
  latestNumber
) {
  const firstBlock =
    await findFirstBlockAtOrAfter(
      start,
      latestNumber
    );

  const afterEnd =
    await findFirstBlockAtOrAfter(
      end,
      latestNumber
    );

  const finalBlock =
    Math.min(
      latestNumber,
      afterEnd - 1
    );

  if (
    firstBlock >
    finalBlock
  ) {
    return {
      transactions: 0,
      blocks: 0,
      start,
      end
    };
  }

  let transactions = 0;
  let blocks = 0;

  for (
    let batchStart =
      firstBlock;

    batchStart <=
      finalBlock;

    batchStart +=
      BLOCK_FETCH_CONCURRENCY
  ) {
    const batchEnd =
      Math.min(
        finalBlock,
        batchStart +
          BLOCK_FETCH_CONCURRENCY -
          1
      );

    const promises = [];

    for (
      let number =
        batchStart;

      number <=
        batchEnd;

      number++
    ) {
      promises.push(
        getBlock(number)
      );
    }

    const result =
      await Promise.all(
        promises
      );

    for (
      const block of result
    ) {
      if (!block) {
        continue;
      }

      if (
        block.timestamp >= start &&
        block.timestamp < end
      ) {
        transactions +=
          block.transactions;

        blocks += 1;
      }
    }
  }

  return {
    transactions,
    blocks,
    start,
    end
  };
}


/* =========================
   LIVE MINUTE
========================= */

async function getLiveMinute(
  start,
  latestNumber
) {
  if (redisAvailable()) {
    const raw =
      await redisCommand([
        "GET",
        liveMinuteKey(start)
      ]);

    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
      }
    }
  }

  const value =
    await calculateInterval(
      start,
      start +
        MINUTE_MS,
      latestNumber
    );

  if (redisAvailable()) {
    await redisCommand([
      "SET",
      liveMinuteKey(start),
      JSON.stringify(value),
      "EX",
      "172800"
    ]);
  }

  return value;
}


/* =========================
   LIVE 5 MINUTES
========================= */

async function getLiveFiveMinutes(
  start,
  latestNumber
) {
  if (redisAvailable()) {
    const raw =
      await redisCommand([
        "GET",
        liveFiveKey(start)
      ]);

    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
      }
    }
  }

  const value =
    await calculateInterval(
      start,
      start +
        FIVE_MINUTES_MS,
      latestNumber
    );

  if (redisAvailable()) {
    await redisCommand([
      "SET",
      liveFiveKey(start),
      JSON.stringify(value),
      "EX",
      "172800"
    ]);
  }

  return value;
}


/* =========================
   HISTORY START
========================= */

function getHistoryStart(now) {
  const todayStart =
    getUtcDayStart(now);

  return (
    todayStart -
    HISTORY_DAYS *
      DAY_MS
  );
}


/* =========================
   INITIALIZE CURSOR
========================= */

async function initializeCursor(
  now,
  latestNumber
) {
  const existing =
    await redisCommand([
      "GET",
      CURSOR_BLOCK_KEY
    ]);

  if (
    existing !== null &&
    existing !== undefined
  ) {
    const number =
      Number(existing);

    if (
      Number.isInteger(number) &&
      number >= 0
    ) {
      return number;
    }
  }

  const start =
    getHistoryStart(now);

  const firstBlock =
    await findFirstBlockAtOrAfter(
      start,
      latestNumber
    );

  await redisPipeline([
    [
      "SET",
      CURSOR_BLOCK_KEY,
      firstBlock.toString()
    ],
    [
      "SET",
      PROCESSED_THROUGH_KEY,
      start.toString()
    ]
  ]);

  return firstBlock;
}


/* =========================
   SAVE AGGREGATED MINUTES
========================= */

async function saveMinuteGroups(
  groups
) {
  const entries =
    Array.from(
      groups.entries()
    );

  if (
    entries.length === 0
  ) {
    return;
  }

  /*
    Read existing minute values
    in one Redis HTTP request.
  */
  const readCommands =
    entries.map(
      ([minuteStart]) => {
        const dayStart =
          getUtcDayStart(
            minuteStart
          );

        const dayKey =
          dayKeyFromStart(
            dayStart
          );

        const field =
          minuteIndexInDay(
            minuteStart
          ).toString();

        return [
          "HGET",
          minuteHashKey(dayKey),
          field
        ];
      }
    );


  const existing =
    await redisPipeline(
      readCommands
    );


  const writeCommands = [];


  for (
    let i = 0;
    i < entries.length;
    i++
  ) {
    const [
      minuteStart,
      addition
    ] = entries[i];

    let oldTransactions = 0;
    let oldBlocks = 0;

    const response =
      existing[i];

    if (
      response &&
      response.result
    ) {
      try {
        const old =
          JSON.parse(
            response.result
          );

        oldTransactions =
          Number(
            old.transactions ||
            0
          );

        oldBlocks =
          Number(
            old.blocks ||
            0
          );

      } catch {
      }
    }


    const value = {
      transactions:
        oldTransactions +
        addition.transactions,

      blocks:
        oldBlocks +
        addition.blocks,

      start:
        minuteStart,

      end:
        minuteStart +
        MINUTE_MS
    };


    const dayStart =
      getUtcDayStart(
        minuteStart
      );

    const dayKey =
      dayKeyFromStart(
        dayStart
      );

    const field =
      minuteIndexInDay(
        minuteStart
      ).toString();


    writeCommands.push([
      "HSET",
      minuteHashKey(dayKey),
      field,
      JSON.stringify(value)
    ]);
  }


  await redisPipeline(
    writeCommands
  );
}


/* =========================
   BLOCK BACKFILL
========================= */

async function backfillHistory(
  now,
  currentMinuteStart,
  latestNumber
) {
  if (!redisAvailable()) {
    return;
  }

  let cursor =
    await initializeCursor(
      now,
      latestNumber
    );

  if (
    cursor >
    latestNumber
  ) {
    await redisCommand([
      "SET",
      PROCESSED_THROUGH_KEY,
      currentMinuteStart.toString()
    ]);

    return;
  }


  const groups =
    new Map();

  let processed = 0;

  let stoppedAtCurrentMinute =
    false;

  let lastProcessedTimestamp =
    null;


  while (
    processed <
      BACKFILL_BLOCKS_PER_REFRESH &&
    cursor <=
      latestNumber &&
    !stoppedAtCurrentMinute
  ) {
    const remaining =
      BACKFILL_BLOCKS_PER_REFRESH -
      processed;

    const batchEnd =
      Math.min(
        latestNumber,

        cursor +
          BLOCK_FETCH_CONCURRENCY -
          1,

        cursor +
          remaining -
          1
      );


    const promises = [];

    for (
      let number =
        cursor;

      number <=
        batchEnd;

      number++
    ) {
      promises.push(
        getBlock(number)
      );
    }


    const blocks =
      await Promise.all(
        promises
      );


    for (
      const block of blocks
    ) {
      if (!block) {
        continue;
      }


      /*
        Do not backfill the currently
        unfinished minute.
      */
      if (
        block.timestamp >=
        currentMinuteStart
      ) {
        stoppedAtCurrentMinute =
          true;

        /*
          Every block before this
          timestamp has already been
          processed, so all completed
          minutes are now known.
        */
        lastProcessedTimestamp =
          currentMinuteStart;

        cursor =
          block.number;

        break;
      }


      const minuteStart =
        getMinuteStart(
          block.timestamp
        );


      const existing =
        groups.get(
          minuteStart
        ) || {
          transactions: 0,
          blocks: 0
        };


      existing.transactions +=
        block.transactions;

      existing.blocks += 1;


      groups.set(
        minuteStart,
        existing
      );


      lastProcessedTimestamp =
        block.timestamp;

      cursor =
        block.number + 1;

      processed += 1;
    }


    if (
      !stoppedAtCurrentMinute &&
      cursor <= batchEnd
    ) {
      cursor =
        batchEnd + 1;
    }
  }


  await saveMinuteGroups(
    groups
  );


  /*
    If we consumed every known block
    before the active minute, all
    completed minutes are known.
  */
  if (
    cursor >
      latestNumber
  ) {
    lastProcessedTimestamp =
      currentMinuteStart;
  }


  const commands = [
    [
      "SET",
      CURSOR_BLOCK_KEY,
      cursor.toString()
    ]
  ];


  if (
    Number.isFinite(
      lastProcessedTimestamp
    )
  ) {
    commands.push([
      "SET",
      PROCESSED_THROUGH_KEY,
      lastProcessedTimestamp
        .toString()
    ]);
  }


  await redisPipeline(
    commands
  );
}


/* =========================
   PROCESSED THROUGH
========================= */

async function getProcessedThrough() {
  if (!redisAvailable()) {
    return 0;
  }

  const raw =
    await redisCommand([
      "GET",
      PROCESSED_THROUGH_KEY
    ]);

  const value =
    Number(raw);

  return Number.isFinite(value)
    ? value
    : 0;
}


/* =========================
   DAY SUMMARY
========================= */

async function buildDaySummary(
  dayStart,
  endTime,
  freeze
) {
  if (!redisAvailable()) {
    return null;
  }

  const processedThrough =
    await getProcessedThrough();


  /*
    Critical v2 rule:

    We only require the blockchain
    cursor to have reached the end
    of the requested period.

    We DO NOT require a Redis field
    for every minute.
  */
  if (
    processedThrough <
    endTime
  ) {
    return null;
  }


  const dayKey =
    dayKeyFromStart(
      dayStart
    );

  const summaryKey =
    daySummaryKey(
      dayKey
    );


  if (freeze) {
    const stored =
      await redisCommand([
        "GET",
        summaryKey
      ]);

    if (stored) {
      try {
        return JSON.parse(
          stored
        );
      } catch {
      }
    }
  }


  const rawValues =
    await redisCommand([
      "HVALS",
      minuteHashKey(dayKey)
    ]);


  let transactions = 0;
  let blocks = 0;


  if (
    Array.isArray(
      rawValues
    )
  ) {
    for (
      const raw of rawValues
    ) {
      try {
        const value =
          JSON.parse(raw);

        /*
          For today we only count
          completed minutes.
        */
        if (
          Number(value.start) >=
          endTime
        ) {
          continue;
        }

        transactions +=
          Number(
            value.transactions ||
            0
          );

        blocks +=
          Number(
            value.blocks ||
            0
          );

      } catch {
      }
    }
  }


  const minutes =
    Math.max(
      0,
      Math.floor(
        (
          endTime -
          dayStart
        ) /
        MINUTE_MS
      )
    );


  const summary = {
    date:
      dayKey,

    transactions,

    blocks,

    minutes,

    complete:
      true
  };


  if (freeze) {
    await redisCommand([
      "SET",
      summaryKey,
      JSON.stringify(summary)
    ]);
  }


  return summary;
}


/* =========================
   SEVEN DAYS
========================= */

async function getSevenDays(
  now
) {
  if (!redisAvailable()) {
    return [];
  }

  const todayStart =
    getUtcDayStart(now);

  const days = [];


  for (
    let offset = 7;
    offset >= 1;
    offset--
  ) {
    const dayStart =
      todayStart -
      offset *
        DAY_MS;

    const dayEnd =
      dayStart +
      DAY_MS;


    const summary =
      await buildDaySummary(
        dayStart,
        dayEnd,
        true
      );


    if (summary) {
      days.push({
        date:
          summary.date,

        transactions:
          summary.transactions
      });
    }
  }


  return days;
}


/* =========================
   HANDLER
========================= */

export default async function handler(
  req,
  res
) {
  try {
    const now =
      Date.now();


    const currentMinuteStart =
      getMinuteStart(now);

    const lastMinuteStart =
      currentMinuteStart -
      MINUTE_MS;


    const currentFiveStart =
      getFiveMinuteStart(
        now
      );

    const lastFiveStart =
      currentFiveStart -
      FIVE_MINUTES_MS;


    const latestHex =
      await rpc(
        "eth_blockNumber"
      );


    const latestNumber =
      Number(
        BigInt(
          latestHex
        )
      );


    /*
      Existing live metrics.
    */

    const lastMinute =
      await getLiveMinute(
        lastMinuteStart,
        latestNumber
      );


    const lastFiveMinutes =
      await getLiveFiveMinutes(
        lastFiveStart,
        latestNumber
      );


    /*
      Historical work happens only
      for the QStash refresh URL.
    */

    if (
      req.query &&
      req.query.refresh === "1"
    ) {
      try {
        await backfillHistory(
          now,
          currentMinuteStart,
          latestNumber
        );

      } catch (error) {
        console.warn(
          "V2 historical backfill error:",
          error
        );
      }
    }


    const todayStart =
      getUtcDayStart(now);


    const today =
      currentMinuteStart >
        todayStart

        ? await buildDaySummary(
            todayStart,
            currentMinuteStart,
            false
          )

        : null;


    const yesterdayStart =
      todayStart -
      DAY_MS;


    const yesterday =
      await buildDaySummary(
        yesterdayStart,
        todayStart,
        true
      );


    const avgTxPerMinute =
      today &&
      today.minutes > 0

        ? today.transactions /
          today.minutes

        : null;


    const avgTxPerBlock =
      today &&
      today.blocks > 0

        ? today.transactions /
          today.blocks

        : null;


    const tps =
      lastMinute.transactions /
      60;


    const sevenDays =
      await getSevenDays(now);


    const processedThrough =
      await getProcessedThrough();


    res.setHeader(
      "Cache-Control",
      "public, s-maxage=20, stale-while-revalidate=40"
    );


    return res
      .status(200)
      .json({

        lastMinute: {
          transactions:
            lastMinute.transactions,

          start:
            lastMinute.start,

          end:
            lastMinute.end
        },


        lastFiveMinutes: {
          transactions:
            lastFiveMinutes.transactions,

          start:
            lastFiveMinutes.start,

          end:
            lastFiveMinutes.end
        },


        today:
          today || null,

        yesterday:
          yesterday || null,

        avgTxPerMinute,

        avgTxPerBlock,

        tps,

        sevenDays,


        latestBlock:
          latestNumber,


        redis:
          redisAvailable()
            ? "connected"
            : "not-configured",


        backfill: {
          version: 2,

          processedThrough:
            processedThrough ||
            null,

          processedThroughIso:
            processedThrough
              ? new Date(
                  processedThrough
                ).toISOString()
              : null
        },


        generatedAt:
          Date.now()
      });


  } catch (error) {
    console.error(
      "Abstract stats error:",
      error
    );


    return res
      .status(500)
      .json({
        error:
          "Could not calculate Abstract statistics."
      });
  }
}
