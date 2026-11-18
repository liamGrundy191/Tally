// Server-side only (reads prompt files from disk); import as "@tally/shared/extraction".
export * from './extractor.ts';
export { AnthropicExtractor } from './anthropic.ts';
export { FakeExtractor } from './fake.ts';
