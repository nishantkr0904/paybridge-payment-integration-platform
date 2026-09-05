#!/usr/bin/env node
import '../config/env.js'; // loads .env
import { closePool } from '../config/database.js';
import {
  formatDemoOutput,
  runRealLLMDemo,
  type DemoExecutionMode
} from './real-llm-demo.js';
import type { CheckoutAbandonmentStage } from '../modules/payment/abandonment.types.js';

interface CliArgs {
  mode?: DemoExecutionMode;
  tier?: 'T1' | 'T2' | 'T3';
  stage?: CheckoutAbandonmentStage;
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (const arg of argv) {
    if (arg.startsWith('--mode=')) {
      const val = arg.substring(7);
      if (val === 'openai' || val === 'deterministic') {
        args.mode = val;
      }
    } else if (arg === '--openai') {
      args.mode = 'openai';
    } else if (arg === '--deterministic' || arg === '--mock') {
      args.mode = 'deterministic';
    } else if (arg.startsWith('--tier=')) {
      const val = arg.substring(7);
      if (val === 'T1' || val === 'T2' || val === 'T3') {
        args.tier = val;
      }
    } else if (arg.startsWith('--stage=')) {
      args.stage = arg.substring(8) as CheckoutAbandonmentStage;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const cliArgs = parseCliArgs(process.argv.slice(2));

  // Determine requested mode
  let requestedMode: DemoExecutionMode =
    cliArgs.mode ||
    (process.env.PAYBRIDGE_REAL_LLM_DEMO === 'true' || process.env.LLM_PROVIDER === 'openai'
      ? 'openai'
      : 'deterministic');

  const apiKey = process.env.OPENAI_API_KEY;

  if (requestedMode === 'openai') {
    if (!apiKey || apiKey.trim() === '') {
      console.log('\n' + '='.repeat(80));
      console.log('⚠️  OPENAI_API_KEY is not configured in the environment.');
      console.log('E1 implementation is complete, but live-provider verification requires OPENAI_API_KEY.');
      console.log('');
      console.log('To execute the live demonstration with OpenAI:');
      console.log('  export OPENAI_API_KEY="sk-..."');
      console.log('  export PAYBRIDGE_REAL_LLM_DEMO=true');
      console.log('  npm run demo:llm');
      console.log('');
      console.log('Falling back to deterministic mode with MockLLMProvider...');
      console.log('='.repeat(80) + '\n');
      requestedMode = 'deterministic';
    } else {
      console.log('\n' + '='.repeat(80));
      console.log('🚀 Executing PayBridge Real LLM Recovery Demonstration with OpenAI...');
      console.log('='.repeat(80) + '\n');
    }
  } else {
    console.log('\n' + '='.repeat(80));
    console.log('🔬 Executing PayBridge LLM Recovery Demonstration in DETERMINISTIC mode (Mock Provider)...');
    console.log('='.repeat(80) + '\n');
  }

  try {
    const result = await runRealLLMDemo({
      mode: requestedMode,
      autonomyTier: cliArgs.tier,
      stage: cliArgs.stage
    });

    console.log(formatDemoOutput(result));
    console.log('');
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('\n❌ Demonstration failed:', errorMsg);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main().catch(async (err) => {
  console.error('Fatal demonstration runner error:', err);
  await closePool();
  process.exit(1);
});
