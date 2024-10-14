import * as dotenv from "dotenv"
import { Keypair, PublicKey, Connection, ParsedTransactionWithMeta, ParsedInstruction, VersionedTransactionResponse, CompiledInstruction, Message, MessageV0, MessageCompiledInstruction, PartiallyDecodedInstruction, ConfirmedSignatureInfo } from "@solana/web3.js"
import { bs58 } from "@project-serum/anchor/dist/cjs/utils/bytes"
import * as fs from "fs"
import csv from "csv-parser"
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token"
import * as path from "path"
import { parse as parseDate } from 'date-fns';
import axios from 'axios';

dotenv.config()

const VERBOSE_LOGGING = false;

function log(...args: any[]) {
  if (VERBOSE_LOGGING) {
    console.log(...args);
  }
}

function warn(...args: any[]) {
  if (VERBOSE_LOGGING) {
    console.warn(...args);
  }
}

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

interface SwapSummary {
  signature: string;
  blockTime: Date;
  inputToken: string;
  outputToken: string;
  volumeUSD: number;
}

interface WalletSummary {
  publicKey: string;
  totalSwaps: number;
  totalVolumeUSD: number;
  swaps: SwapSummary[];
}

// Add a new type to represent both transaction types
type SolanaTransaction = ParsedTransactionWithMeta | VersionedTransactionResponse;

// Add this to your interfaces
interface CoinGeckoPrices {
  [key: string]: {
    usd: number;
  };
}

// Configuration
const configuration = {
  wallet: {
    filePath: "./wallet/wallet.csv",
    separator: ",",
  },
  prices: {
    JUP: 0,
    SOL: 0,
    USDC: 0,
    USDT: 0,
    mSOL: 0,
  },
  "rpc": [
    "https://mainnet.helius-rpc.com/?api-key=4de04758-6b4c-4f82-9e4b-96d81d355e96",
    "https://rpc.ankr.com/solana/df241c807cbce5c01549e5636a2b0068ba5ef75e2d394731f43351f9c0d7cb40",
    "https://rpc.ankr.com/solana/fdcea58fe76c1ea3679c38f7a8ce1b917c06e8a7f71e6b6c793b8ec22be92dab"

  ],
  coinGeckoIds: {
    JUP: "jupiter",
    SOL: "solana",
    USDC: "usd-coin",
    USDT: "tether",
    mSOL: "msol",
  },
};

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

const JUPITER_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

class SolanaService {
  private _rpcUrls: string[] = configuration.rpc
  private _currentRpcIndex: number = 0
  private _heliusRpcUrl: string = "https://mainnet.helius-rpc.com/?api-key=4de04758-6b4c-4f82-9e4b-96d81d355e96"

  public async getConnection(forceHelius: boolean = false): Promise<Connection> {
    try {
      let url: string;
      if (forceHelius) {
        url = this._heliusRpcUrl;
      } else {
        url = this._rpcUrls[this._currentRpcIndex];
        this._currentRpcIndex = (this._currentRpcIndex + 1) % this._rpcUrls.length;
      }
      return new Connection(url, 'confirmed');
    }
    catch (error) {
      console.error("Error creating connection:", error);
      return this.getConnection(forceHelius);
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

  public async getTransactionHistory(publicKey: PublicKey, limit: number = 1000): Promise<(SolanaTransaction | null)[]> {
    const heliusConnection = await this.getConnection(true);

    log(`Fetching signatures for wallet: ${publicKey.toString()} using Helius`);

    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const getSignaturesWithRetry = async (retries = 3, delayMs = 1000): Promise<ConfirmedSignatureInfo[]> => {
      try {
        const signatures = await heliusConnection.getSignaturesForAddress(publicKey, { limit });
        log(`Number of signatures fetched: ${signatures.length}`);
        return signatures;
      } catch (error) {
        if (retries > 0) {
          warn(`Error fetching signatures, retrying in ${delayMs}ms... (${retries} retries left)`);
          await delay(delayMs);
          return getSignaturesWithRetry(retries - 1, delayMs * 2);
        }
        throw error;
      }
    };

    const signatures = await getSignaturesWithRetry();

    if (signatures.length === 0) {
      log(`No signatures found for wallet: ${publicKey.toString()}`);
      return [];
    }

    const allSignatures = signatures.map(sig => sig.signature);

    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000;
    const CONCURRENT_REQUESTS = 30;

    const retryGetTransaction = async (signature: string, retries = 0): Promise<SolanaTransaction | null> => {
      try {
        const connection = await this.getConnection();
        const transaction = await connection.getTransaction(signature, {
          maxSupportedTransactionVersion: 1
        });
        return transaction;
      } catch (error) {
        if (retries < MAX_RETRIES) {
          warn(`Error fetching transaction ${signature}, retrying in ${RETRY_DELAY}ms... (${retries + 1}/${MAX_RETRIES})`);
          await delay(RETRY_DELAY);
          return retryGetTransaction(signature, retries + 1);
        }
        console.error(`Failed to fetch transaction ${signature} after ${MAX_RETRIES} retries`);
        return null;
      }
    };

    const fetchTransactionsInParallel = async (signatures: string[]): Promise<(SolanaTransaction | null)[]> => {
      const results: (SolanaTransaction | null)[] = [];
      for (let i = 0; i < signatures.length; i += CONCURRENT_REQUESTS) {
        const batch = signatures.slice(i, i + CONCURRENT_REQUESTS);
        const batchPromises = batch.map(signature => retryGetTransaction(signature));
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        log(`Fetched transactions ${i + 1} to ${i + batchResults.length} of ${signatures.length}`);
        if (i + CONCURRENT_REQUESTS < signatures.length) {
          await delay(1000);
        }
      }
      return results;
    };

    const allTransactions = await fetchTransactionsInParallel(allSignatures);

    log(`Total transactions fetched: ${allTransactions.length}`);
    log(`Null transactions: ${allTransactions.filter(tx => tx === null).length}`);

    return allTransactions;
  }
}

// New functions for swap analysis
async function isSwapTransaction(transaction: SolanaTransaction | null): Promise<boolean> {
  if (!transaction || !transaction.meta) {
    log('Transaction is null or meta is missing');
    return false;
  }

  let instructions: (ParsedInstruction | PartiallyDecodedInstruction | CompiledInstruction | MessageCompiledInstruction)[];

  function isParsedTransactionWithMeta(transaction: SolanaTransaction): transaction is ParsedTransactionWithMeta {
    return 'transaction' in transaction && 'meta' in transaction;
  }

  const message = transaction.transaction.message;

  if ('instructions' in message) {
    instructions = message.instructions;
  } else {
    const versionedTx = transaction as VersionedTransactionResponse;
    const message = versionedTx.transaction.message
    if (message instanceof Message)
      instructions = message.instructions
    else
      instructions = message.compiledInstructions
  }

  const jupiterInstructions = instructions.filter(instruction =>
    isProgramIdJupiter(instruction, transaction)
  );

  if (jupiterInstructions.length === 0) {
    log('No Jupiter instruction found in transaction');
    return false;
  }

  log(`Found ${jupiterInstructions.length} Jupiter instructions`);

  const preTokenBalances = transaction.meta.preTokenBalances || [];
  const postTokenBalances = transaction.meta.postTokenBalances || [];

  log(`Pre-token balances: ${JSON.stringify(preTokenBalances)}`);
  log(`Post-token balances: ${JSON.stringify(postTokenBalances)}`);

  const balanceChanges = preTokenBalances.filter(preBalance => {
    const postBalance = postTokenBalances.find(post => post.accountIndex === preBalance.accountIndex);
    return postBalance && preBalance.uiTokenAmount.uiAmount !== postBalance.uiTokenAmount.uiAmount;
  });

  log(`Found ${balanceChanges.length} token balance changes`);

  return balanceChanges.length > 0;
}

// Update the isProgramIdJupiter function to handle MessageCompiledInstruction
function isProgramIdJupiter(
  instruction: ParsedInstruction | PartiallyDecodedInstruction | CompiledInstruction | MessageCompiledInstruction,
  transaction: SolanaTransaction
): boolean {
  if ('programId' in instruction) {
    // This is a ParsedInstruction or PartiallyDecodedInstruction
    return instruction.programId.toString() === JUPITER_PROGRAM_ID;
  } else if ('programIdIndex' in instruction) {
    // This is a CompiledInstruction or MessageCompiledInstruction
    const message = (transaction as VersionedTransactionResponse).transaction.message;
    let programIdPubkey: PublicKey;

    if (message instanceof Message) {
      programIdPubkey = message.accountKeys[instruction.programIdIndex];
    } else {
      programIdPubkey = message.staticAccountKeys[instruction.programIdIndex];
    }

    return programIdPubkey.toString() === JUPITER_PROGRAM_ID;
  }

  return false;
}

async function calculateSwapVolumeUSD(transaction: SolanaTransaction | null, tokens: Token[]): Promise<number> {
  if (!transaction || !transaction.meta) {
    log('Transaction is null or meta is missing');
    return 0;
  }

  const preTokenBalances = transaction.meta.preTokenBalances || [];
  const postTokenBalances = transaction.meta.postTokenBalances || [];

  log(`Pre-token balances: ${JSON.stringify(preTokenBalances)}`);
  log(`Post-token balances: ${JSON.stringify(postTokenBalances)}`);

  let inputAmount = 0;
  let outputAmount = 0;
  let inputToken: Token | undefined;
  let outputToken: Token | undefined;

  for (const preBalance of preTokenBalances) {
    const postBalance = postTokenBalances.find(post => post.accountIndex === preBalance.accountIndex);
    if (postBalance) {
      const token = tokens.find(t => t.mintAddress === preBalance.mint);
      if (token) {
        const preBal = preBalance.uiTokenAmount.uiAmount || 0;
        const postBal = postBalance.uiTokenAmount.uiAmount || 0;
        const difference = postBal - preBal;
        log(`Token ${token.symbol} balance change: ${difference} (pre: ${preBal}, post: ${postBal})`);
        if (difference < 0) {
          inputAmount = Math.abs(difference);
          inputToken = token;
        } else if (difference > 0) {
          outputAmount = difference;
          outputToken = token;
        }
      } else {
        log(`Token not found for mint address: ${preBalance.mint}`);
      }
    }
  }

  log(`Input token: ${inputToken?.symbol}, amount: ${inputAmount}`);
  log(`Output token: ${outputToken?.symbol}, amount: ${outputAmount}`);

  if (!inputToken || !outputToken) {
    log('Could not identify both input and output tokens');
    return 0;
  }

  const inputUSD = inputAmount * (configuration.prices[inputToken.symbol as keyof typeof configuration.prices] || 0);
  const outputUSD = outputAmount * (configuration.prices[outputToken.symbol as keyof typeof configuration.prices] || 0);

  log(`Input USD: ${inputUSD}, Output USD: ${outputUSD}`);

  return Math.max(inputUSD, outputUSD);
}

async function analyzeSwaps(wallet: Wallet, solanaService: SolanaService, tokens: Token[], cutoffDate: Date): Promise<WalletSummary> {
  const publicKey = new PublicKey(wallet.publicKey);
  const transactions = await solanaService.getTransactionHistory(publicKey);
  let totalVolumeUSD = 0;
  let swapCount = 0;
  let swaps: SwapSummary[] = [];

  console.log(`\nAnalyzing ${transactions.length} transactions for wallet ${wallet.publicKey}`);

  for (const transaction of transactions) {
    if (transaction && transaction.blockTime && new Date(transaction.blockTime * 1000) >= cutoffDate) {
      try {
        const isSwap = await isSwapTransaction(transaction);
        if (isSwap) {
          const swapVolumeUSD = await calculateSwapVolumeUSD(transaction, tokens);
          if (swapVolumeUSD > 0) {
            swapCount++;
            totalVolumeUSD += swapVolumeUSD;

            const { inputToken, outputToken } = identifySwapTokens(transaction, tokens);

            swaps.push({
              signature: transaction.transaction?.signatures[0] || 'Unknown',
              blockTime: new Date(transaction.blockTime * 1000),
              inputToken,
              outputToken,
              volumeUSD: swapVolumeUSD
            });
          }
        }
      } catch (error) {
        console.error(`Error processing transaction ${transaction.transaction?.signatures[0]}:`, error);
      }
    }
  }

  return {
    publicKey: wallet.publicKey,
    totalSwaps: swapCount,
    totalVolumeUSD,
    swaps
  };
}

function identifySwapTokens(transaction: SolanaTransaction | null, tokens: Token[]): { inputToken: string, outputToken: string } {
  if (!transaction || !transaction.meta) {
    return { inputToken: 'Unknown', outputToken: 'Unknown' };
  }

  const preTokenBalances = transaction.meta.preTokenBalances || [];
  const postTokenBalances = transaction.meta.postTokenBalances || [];

  let inputToken = 'Unknown';
  let outputToken = 'Unknown';

  for (const preBalance of preTokenBalances) {
    const postBalance = postTokenBalances.find(post => post.accountIndex === preBalance.accountIndex);
    if (postBalance) {
      const token = tokens.find(t => t.mintAddress === preBalance.mint);
      if (token) {
        const preBal = preBalance.uiTokenAmount.uiAmount || 0;
        const postBal = postBalance.uiTokenAmount.uiAmount || 0;
        if (postBal < preBal) {
          inputToken = token.symbol;
        } else if (postBal > preBal) {
          outputToken = token.symbol;
        }
      }
    }
  }

  return { inputToken, outputToken };
}

// In your main function or wherever you're calling analyzeSwaps:
async function processWallets(wallets: Wallet[], solanaService: SolanaService, tokens: Token[], cutoffDate: Date) {
  for (const wallet of wallets) {
    const summary = await analyzeSwaps(wallet, solanaService, tokens, cutoffDate);
    console.log(`\nSummary for wallet ${summary.publicKey}:`);
    console.log(`Total swaps: ${summary.totalSwaps}`);
    console.log(`Total volume: $${summary.totalVolumeUSD.toFixed(2)} USD`);
 /* console.log('Swaps:');
     summary.swaps.forEach((swap, index) => {
      console.log(`  ${index + 1}. ${swap.inputToken} -> ${swap.outputToken}`);
      console.log(`     Date: ${swap.blockTime.toISOString()}`);
      console.log(`     Volume: $${swap.volumeUSD.toFixed(2)} USD`);
      console.log(`     Signature: ${swap.signature}`);
    }); */
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

// Add this function to fetch prices from CoinGecko
async function updatePricesFromCoinGecko() {
  const ids = Object.values(configuration.coinGeckoIds).join(',');
  try {
    const response = await axios.get<CoinGeckoPrices>(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const prices = response.data;

    for (const [symbol, id] of Object.entries(configuration.coinGeckoIds)) {
      if (prices[id]) {
        configuration.prices[symbol as keyof typeof configuration.prices] = prices[id].usd;
      }
    }

    console.log("Updated prices:", configuration.prices);
  } catch (error) {
    console.error("Error fetching prices from CoinGecko:", error);
  }
}

async function init(outputFilePath: string, mode: 'balances' | 'swaps', cutoffDateString?: string) {
  // Check if the file already exists
  if (fs.existsSync(outputFilePath)) {
    console.error(`Error: File '${outputFilePath}' already exists. Exiting.`)
    process.exit(1)
  }

  // Fetch latest prices
  await updatePricesFromCoinGecko();

  const reader = new FileReader()
  const solanaService = new SolanaService()
  const wallets = await readWalletsInformation(reader)

  if (mode === 'balances') {
    await runBalancesMode(wallets, solanaService, outputFilePath);
  } else if (mode === 'swaps') {
    const cutoffDate = cutoffDateString ? parseDate(cutoffDateString, 'yyyy-MM-dd', new Date()) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await runSwapsMode(wallets, solanaService, outputFilePath, cutoffDateString)
  }
}

async function runBalancesMode(wallets: Wallet[], solanaService: SolanaService, outputFilePath: string) {
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

  fs.writeFileSync(outputFilePath, JSON.stringify(sortedWalletBalances, null, 2))
  console.log(`Sorted wallet balances saved to: ${outputFilePath}`)
}

async function runSwapsMode(wallets: Wallet[], solanaService: SolanaService, outputFilePath: string, cutoffDateString?: string) {
  let cutoffDate: Date;
  if (cutoffDateString) {
    cutoffDate = parseDate(cutoffDateString, 'yyyy-MM-dd', new Date());
  } else {
    cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - 1);
  }

  let walletSwapVolumes: { wallet: Wallet, swapVolumeUSD: number }[] = []

  for (const wallet of wallets) {
    const walletSummary = await analyzeSwaps(wallet, solanaService, tokens, cutoffDate)
    walletSwapVolumes.push({ wallet, swapVolumeUSD: walletSummary.totalVolumeUSD })
  }

  const sortedWalletSwapVolumes = walletSwapVolumes.sort((a, b) => b.swapVolumeUSD - a.swapVolumeUSD)

  fs.writeFileSync(outputFilePath, JSON.stringify(sortedWalletSwapVolumes, null, 2))
  console.log(`Sorted wallet swap volumes saved to: ${outputFilePath}`)
}

// Check if correct arguments are provided
if (process.argv.length < 4) {
  console.error("Error: Please provide mode ('balances' or 'swaps') and an output file path as arguments.")
  console.error("For 'swaps' mode, you can optionally provide a cut-off date (YYYY-MM-DD).")
  process.exit(1)
}

const mode = process.argv[2] as 'balances' | 'swaps';
const outputFilePath = path.resolve(process.argv[3]);
const cutoffDateString = process.argv[4];

if (mode !== 'balances' && mode !== 'swaps') {
  console.error("Error: Mode must be either 'balances' or 'swaps'.")
  process.exit(1)
}

init(outputFilePath, mode, cutoffDateString)