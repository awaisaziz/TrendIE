import { collectCapabilities } from './capabilities.js';

const token = process.env.QATOM_MCP_TOKEN || process.env.QATOM_API_KEY;
const evidence = await collectCapabilities(token ? { token } : {});
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
