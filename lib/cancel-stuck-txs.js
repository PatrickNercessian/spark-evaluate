import pRetry from 'p-retry'
import assert from 'node:assert'
import * as Sentry from '@sentry/node'
import ms from 'ms'
import timers from 'node:timers/promises'

const ROUND_LENGTH_MS = ms('20 minutes')
const CHECK_STUCK_TXS_DELAY = ms('1 minute')

/**
  * @param {string} f4addr
  * @returns 1000 oldest messages
  */
export async function getMessagesInMempool (f4addr) {
  const res = await pRetry(
    async () => {
      const res = await fetch(`https://filfox.info/api/v1/message/mempool/filtered-list?address=${f4addr}&pageSize=1000`)
      if (!res.ok) {
        throw new Error(`Filfox request failed with ${res.status}: ${(await res.text()).trimEnd()}`)
      }
      return res
    },
    {
      async onFailedAttempt (error) {
        console.warn(error)
        console.warn('Filfox request failed. Retrying...')
      }
    }
  )

  /** @type {{
     messages: {
      cid: string;
      from: string;
      to: string;
      nonce: number;
      value: string;
      gasLimit: number;
      gasFeeCap: string;
      gasPremium: string;
      method: string;
      methodNumber: number;
      evmMethod: string;
      createTimestamp: number;
    }[];
  }}
  */
  const { messages } = /** @type {any} */(await res.json())
  return messages
}

/**
 * @returns {Promise<{
  cid: string;
  height: number;
  timestamp: number;
  gasLimit: number;
  gasFeeCap: string;
  gasPremium: string;
  method: string;
  methodNumber: number;
  receipt: {
    exitCode: number;
    return: string;
    gasUsed: number;
  },
  size: number;
  error: string;
  baseFee: string;
  fee: {
    baseFeeBurn: string;
    overEstimationBurn: string;
    minerPenalty: string;
    minerTip: string;
    refund: string;
  },
}>}
*/
export async function getRecentSendMessage () {
  let res = await fetch('https://filfox.info/api/v1/message/list?method=Send')
  if (!res.ok) {
    throw new Error(`Filfox request failed with ${res.status}: ${(await res.text()).trimEnd()}`)
  }
  const body = /** @type {any} */(await res.json())
  assert(body.messages.length > 0, '/message/list returned an empty list')
  const sendMsg = body.messages.find(m => m.method === 'Send')
  assert(!!sendMsg, 'No Send message found in the recent committed messages')
  const cid = sendMsg.cid

  res = await fetch(`https://filfox.info/api/v1/message/${cid}`)
  if (!res.ok) {
    throw new Error(`Filfox request failed with ${res.status}: ${(await res.text()).trimEnd()}`)
  }

  return /** @type {any} */(await res.json())
}

const cancelTx = async ({ tx, signer, recentGasUsed, recentGasFeeCap }) => {
  const oldGasPremium = Number(tx.gasPremium)
  const nonce = tx.nonce

  console.log(`Replacing ${tx.cid}...`)
  try {
    const replacementTx = await signer.sendTransaction({
      to: signer.address,
      value: 0,
      nonce,
      gasLimit: Math.ceil(recentGasUsed * 1.1),
      maxFeePerGas: recentGasFeeCap,
      // Increase by 25% + 1 attoFIL (easier: 25.2%)
      maxPriorityFeePerGas: Math.ceil(oldGasPremium * 1.252)
    })
    console.log(
      `Waiting for receipt of replacement ${replacementTx.hash} for ${tx.cid}`
    )
    await replacementTx.wait()
    console.log(`Replaced ${tx.cid} with ${replacementTx.hash}`)
  } catch (err) {
    console.error(err)
    Sentry.captureException(err)
  }
}

const cancelStuckTxs = async ({ walletDelegatedAddress, signer }) => {
  console.log('Checking for stuck transactions...')

  const messages = await getMessagesInMempool(walletDelegatedAddress)
  const txsToCancel = messages.filter(m => {
    return m.createTimestamp * 1000 < Date.now() - (2 * ROUND_LENGTH_MS)
  })
  if (txsToCancel.length === 0) {
    console.log('No transactions to cancel')
    return false
  }

  console.log('Transactions to cancel:')
  for (const tx of txsToCancel) {
    console.log(
      '-',
      tx.cid,
      `(age ${ms(Date.now() - (tx.createTimestamp * 1000))})`
    )
  }

  const recentSendMessage = await getRecentSendMessage()
  console.log('Calculating gas fees from the recent Send message %s (created at %s)',
    recentSendMessage.cid,
    new Date(recentSendMessage.timestamp * 1000).toISOString()
  )

  const recentGasUsed = recentSendMessage.receipt.gasUsed
  const recentGasFeeCap = Number(recentSendMessage.gasFeeCap)

  await Promise.all(txsToCancel.map(async tx => {
    await cancelTx({ tx, signer, recentGasUsed, recentGasFeeCap })
  }))

  return true
}

export const startCancelStuckTxs = async ({
  walletDelegatedAddress,
  signer
}) => {
  while (true) {
    let didCancelTxs = false
    try {
      didCancelTxs = await cancelStuckTxs({
        walletDelegatedAddress,
        signer
      })
    } catch (err) {
      console.error(err)
      Sentry.captureException(err)
    }
    if (!didCancelTxs) {
      await timers.setTimeout(CHECK_STUCK_TXS_DELAY)
    }
  }
}
