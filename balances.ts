import * as dotenv from "dotenv"
import { Keypair, PublicKey, Connection } from "@solana/web3.js"
import { bs58 } from "@project-serum/anchor/dist/cjs/utils/bytes"
import * as fs from "fs"
import csv from "csv-parser"
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token"
import * as path from "path"

dotenv.config()

// Interfaces and types
interface Wallet {
  publicKey: string
  secretKey: string
}

interface Token {
  symbol: string
  decimals: number
  mintAddress: string
}

type Currency = "SOL" | "USDC" | "USDT" | "JUP" | "mSOL" | "JLP"

interface Reader {
  readCSVFile<T>(filePath: string, columnSeparator: string, headers?: Array<string>): Promise<{ data: T[]; error?: Error }>
}

interface TokenAccountInformation {
  publicKey: string
  balance: number
  tokenSymbol: string
  mintAddress: string
}

// Configuration
const configuration = {
  wallet: {
    filePath: "./wallet/wallet.csv",
    separator: ",",
  },
  prices: {
    JUP: 0.74,
    SOL: 143,
    USDC: 1,
    USDT: 1,
    mSOL: 170,
  },
  "rpc": [
    "https://mainnet.helius-rpc.com/?api-key=4de04758-6b4c-4f82-9e4b-96d81d355e96",
    "https://rpc.ankr.com/solana/df241c807cbce5c01549e5636a2b0068ba5ef75e2d394731f43351f9c0d7cb40"
  ],
}

// Reader implementation
class FileReader implements Reader {
  public async readCSVFile<T>(
    filePath: string,
    columnSeparator: string,
    headers?: Array<string>,
  ): Promise<{ data: T[]; error?: Error }> {
    return new Promise<{ data: T[]; error?: Error }>((resolve, reject) => {
      let results: T[] = []

      fs.createReadStream(filePath)
        .pipe(csv({ separator: columnSeparator, headers }))
        .on("data", (row: T) => {
          results.push(row)
        })
        .on("end", () => {
          resolve({ data: results })
        })
        .on("error", (error: Error) => {
          reject({ error })
        })
    })
  }
}

// Token data
const tokens: Token[] = [
  { symbol: "JUP", decimals: 6, mintAddress: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { symbol: "SOL", decimals: 9, mintAddress: "So11111111111111111111111111111111111111112" },
  { symbol: "USDC", decimals: 6, mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { symbol: "USDT", decimals: 6, mintAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
  { symbol: "mSOL", decimals: 9, mintAddress: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So" },
]

class SolanaService {
  private _rpcUrls: string[] = configuration.rpc
  private _currentRpcIndex: number = 0

  public async getConnection(): Promise<Connection> {
    try {
      const url = this._rpcUrls[this._currentRpcIndex]
      this._currentRpcIndex = (this._currentRpcIndex + 1) % this._rpcUrls.length
      return new Connection(url)
    }
    catch (error) {
      return this.getConnection();
    }
  }

  public async getBalance(publicKey: PublicKey): Promise<number> {
    const connection = await this.getConnection()
    return connection.getBalance(publicKey)
  }

  public async getParsedAccountInfo(publicKey: PublicKey) {
    const connection = await this.getConnection()
    return connection.getParsedAccountInfo(publicKey)
  }

  public async getAssociatedTokenAddress(ownerPublicKey: PublicKey, tokenMint: string): Promise<string> {
    const tokenMintPublicKey = new PublicKey(tokenMint)
    const associatedTokenAddress = await getAssociatedTokenAddress(tokenMintPublicKey, ownerPublicKey)
    return associatedTokenAddress.toBase58()
  }

  public async getAssociatedTokenAccountInformation(
    publicKey: PublicKey,
    tokenSymbol: string,
    tokenMint: string,
  ): Promise<TokenAccountInformation | null> {
    const associatedTokenAddress = await this.getAssociatedTokenAddress(publicKey, tokenMint)
    const parsedAccountInformation = await this.getParsedAccountInfo(new PublicKey(associatedTokenAddress))

    if (parsedAccountInformation.value && "parsed" in parsedAccountInformation.value.data) {
      const parsedData = parsedAccountInformation.value.data.parsed
      return {
        publicKey: associatedTokenAddress,
        balance: parseFloat(parsedData.info.tokenAmount.amount),
        tokenSymbol: tokenSymbol,
        mintAddress: tokenMint,
      }
    }

    return null
  }

  public async getSystemProgramAccountBalance(publicKey: PublicKey): Promise<number> {
    return this.getBalance(publicKey)
  }

  public async getWalletAccountBalanceInternal(publicKey: PublicKey, currency: Currency) {
    if (currency == "SOL") {
      const balance = await this.getSystemProgramAccountBalance(publicKey)
      return balance
    } else {
      const token = tokens.find(token => token.symbol === currency)!
      const associatedTokenAccountInformation = await this.getAssociatedTokenAccountInformation(
        publicKey,
        token.symbol,
        token.mintAddress,
      )
      if (associatedTokenAccountInformation) {
        return associatedTokenAccountInformation.balance
      } else {
        return 0
      }
    }  
  }
}

// Main functionality
async function convertWalletBalancesToUSD(tokens: Token[], walletBalances: { wallet: Wallet, balances: { amount: number, currency: Currency }[] }[]) {
  let convertedWalletBalances: { wallet: Wallet, usdBalances: { amount: Number, currency: Currency }[], usdTotal: number }[] = []
  for (const walletBalance of walletBalances) {
    const usdBalances = walletBalance.balances.map(balance => {
      let convertedAmount: number
      const token = tokens.find(token => token.symbol == balance.currency)!
      const decimals = token.decimals
      const balanceLargestUnits = balance.amount / 10 ** decimals
      switch (balance.currency) {
        case "JUP":
          convertedAmount = configuration.prices.JUP * balanceLargestUnits
          break
        case "SOL":
          convertedAmount = configuration.prices.SOL * balanceLargestUnits
          break
        case "USDC":
          convertedAmount = configuration.prices.USDC * balanceLargestUnits
          break
        case "USDT":
          convertedAmount = configuration.prices.USDT * balanceLargestUnits
          break
        case "mSOL":
          convertedAmount = configuration.prices.mSOL * balanceLargestUnits
          break
        default:
          throw new Error(`Unsupported currency: ${balance.currency}`)
      }
      return { currency: balance.currency, amount: convertedAmount }
    })
    const usdTotal = usdBalances.reduce((current, usdBalance) => usdBalance.amount + current, 0)
    convertedWalletBalances.push({
      wallet: walletBalance.wallet, usdBalances, usdTotal
    })
  }
  return convertedWalletBalances
}

async function readWalletsInformation(reader: Reader) {
  const wallet = configuration.wallet
  const walletsFilePath = wallet.filePath
  const separator = wallet.separator
  const walletsFileReadResult = await reader.readCSVFile<Wallet>(walletsFilePath, separator, [
    "publicKey",
    "secretKey",
  ])
  const walletsBase58 = walletsFileReadResult.data.map(wallet => {
    const keyPair = Keypair.fromSecretKey(Buffer.from(wallet.secretKey, "hex"))
    return {
      publicKey: keyPair.publicKey.toBase58(),
      secretKey: bs58.encode(keyPair.secretKey),
    }
  })
  return walletsBase58
}

async function init(outputFilePath: string) {
  // Check if the file already exists
  if (fs.existsSync(outputFilePath)) {
    console.error(`Error: File '${outputFilePath}' already exists. Exiting.`)
    process.exit(1)
  }

  const reader = new FileReader()
  const solanaService = new SolanaService()
  const wallets = await readWalletsInformation(reader)
  const currencies = tokens.map(token => token.symbol as Currency)
  let walletBalances: { wallet: Wallet, balances: { amount: number, currency: Currency }[] }[] = []
  let failedRetrievals = []

  for (const wallet of wallets) {
    let balances: { amount: number, currency: Currency }[] = []
    let failed: Currency[] = []
    const publicKey = new PublicKey(wallet.publicKey)
    for (const currency of currencies) {
      try {
        const amount = await solanaService.getWalletAccountBalanceInternal(publicKey, currency)
        balances.push({ amount, currency })
      }
      catch (error) {
        failed.push(currency)
      }
    }
    walletBalances.push({ wallet, balances })
    failedRetrievals.push({ wallet, failed })
  }

  const walletBalancesUSD = await convertWalletBalancesToUSD(tokens, walletBalances)
  const sortedWalletBalances = walletBalancesUSD.sort((a, b) => b.usdTotal - a.usdTotal) 

  // Save sorted balances to the specified file
  fs.writeFileSync(outputFilePath, JSON.stringify(sortedWalletBalances, null, 2))
  console.log(`Sorted wallet balances saved to: ${outputFilePath}`)
}

// Check if a file path argument is provided
if (process.argv.length < 3) {
  console.error("Error: Please provide an output file path as an argument.")
  process.exit(1)
}

const outputFilePath = path.resolve(process.argv[2])
init(outputFilePath)
