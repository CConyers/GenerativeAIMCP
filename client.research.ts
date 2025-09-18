import 'dotenv/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { confirm, input, select } from '@inquirer/prompts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CreateMessageRequestSchema,
  Prompt,
  PromptMessage,
  Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';
import { generateText, jsonSchema, ToolSet } from 'ai';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'node:fs/promises';
import path from 'node:path';
import { marked } from 'marked';
import HTMLtoDOCX from 'html-to-docx';

// Your existing constant
import { MCP_RESULT_PROMPT } from './constants.js';

// === QuickChart tool wrapper (import your existing implementation) ===
import { chartTools as quickChartTools } from './chart-tools.js';

// --------------------------- Server setup ----------------------------
const serverConfigs = [
  {
    name: 'Brave Search',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: {
      BRAVE_API_KEY: process.env.BRAVE_API_KEY || '',
    },
    type: 'stdio' as const,
  },
  {
    name: 'Alphavantage',
    url: `https://mcp.alphavantage.co/mcp?apikey=${process.env.ALPHAVANTAGE_API_KEY}`,
    type: 'http' as const,
  },
];

const clients: Record<string, Client> = {};
const transports: Record<
  string,
  StdioClientTransport | StreamableHTTPClientTransport
> = {};

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// --------------------------- Helpers ----------------------------
function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function formatLondonDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

// --- Charts plumbing ---
type GeneratedChart = {
  url: string;
  type: 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter' | 'radar';
  title?: string;
  args:
    | { type: string; data: number[]; labels: string[]; title?: string }
    | {
        type: string;
        datasets: Array<{ label: string; data: number[]; color?: string }>;
        labels: string[];
        title?: string;
      };
};

function buildChartToolset(generated: GeneratedChart[]): ToolSet {
  const extractUrl = (text?: string) => {
    const m = text?.match(/https?:\/\/\S+/);
    return m ? m[0] : undefined;
  };

  return {
    create_chart: {
      description: quickChartTools.create_chart.description,
      parameters: quickChartTools.create_chart.parameters,
      execute: async (args: any) => {
        const res = await quickChartTools.create_chart.execute(args);
        const text = (res?.content?.[0] as any)?.text as string | undefined;
        const url = extractUrl(text);
        if (url) {
          generated.push({
            url,
            type: args.type,
            title: args.title,
            args: {
              type: args.type,
              data: args.data,
              labels: args.labels,
              title: args.title,
            },
          });
        }
        return res as any;
      },
    },
    create_multi_dataset_chart: {
      description: quickChartTools.create_multi_dataset_chart.description,
      parameters: quickChartTools.create_multi_dataset_chart.parameters,
      execute: async (args: any) => {
        const res = await quickChartTools.create_multi_dataset_chart.execute(
          args
        );
        const text = (res?.content?.[0] as any)?.text as string | undefined;
        const url = extractUrl(text);
        if (url) {
          generated.push({
            url,
            type: args.type,
            title: args.title,
            args: {
              type: args.type,
              datasets: args.datasets,
              labels: args.labels,
              title: args.title,
            },
          });
        }
        return res as any;
      },
    },
    create_comparison_chart: {
      description: quickChartTools.create_comparison_chart.description,
      parameters: quickChartTools.create_comparison_chart.parameters,
      execute: async (args: any) => {
        const res = await quickChartTools.create_comparison_chart.execute(args);
        const text = (res?.content?.[0] as any)?.text as string | undefined;
        const url = extractUrl(text);
        if (url) {
          const datasets = [
            { label: args.label1, data: args.data1, color: '#FF6384' },
            { label: args.label2, data: args.data2, color: '#36A2EB' },
          ];
          generated.push({
            url,
            type: (args.type || 'bar') as GeneratedChart['type'],
            title: args.title,
            args: {
              type: args.type || 'bar',
              datasets,
              labels: args.labels,
              title: args.title,
            },
          });
        }
        return res as any;
      },
    },
  } as ToolSet;
}

async function explainChart(args: GeneratedChart['args'], type: string) {
  const { text } = await generateText({
    model: google('gemini-2.0-flash'),
    prompt: `Write a clear, data-driven explanation for a ${type} chart.\n\nData:\n${JSON.stringify(
      args,
      null,
      2
    )}\n\nInstructions:\n- Start with a 1–2 sentence caption describing the main takeaway.\n- Then add 3–5 bullets highlighting trends, outliers, comparisons, and (if applicable) percentages or growth.\n- Keep it factual; do not invent data.\n- No prefaces; return Markdown only.`,
  });
  return text ?? '';
}

async function fetchAsDataUri(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download chart: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// --------------------------- DOCX Export ----------------------------
async function saveResearchAsDocx({
  query,
  markdown,
  sourcesBlock,
  charts = [],
  outDir = process.cwd(),
}: {
  query: string;
  markdown: string;
  sourcesBlock: string;
  charts?: Array<{
    title?: string;
    dataUri: string;
    explanationMd: string;
    alt?: string;
  }>;
  outDir?: string;
}) {
  const htmlBody = marked.parse(markdown) as string;

  const sourcesHtml = sourcesBlock
    .split('\n\n')
    .map(chunk => {
      const safe = chunk
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const linked = safe.replace(
        /(https?:\/\/[^\s)]+)/g,
        '<a href="$1">$1</a>'
      );
      return `<p>${linked}</p>`;
    })
    .join('\n');

  const chartsHtml = charts.length
    ? `\n<section class="charts">\n  <h2>Charts</h2>\n  ${charts
        .map(
          (c, i) =>
            `\n  <figure style="margin:16px 0;">\n    <img src="${
              c.dataUri
            }" alt="${(c.alt || c.title || `Chart ${i + 1}`).replace(
              /"/g,
              '&quot;'
            )}" style="max-width:100%; height:auto;" />\n    ${
              c.title
                ? `<figcaption><strong>${c.title}</strong></figcaption>`
                : ''
            }\n    <div>${
              marked.parse(c.explanationMd) as string
            }</div>\n  </figure>`
        )
        .join('\n')}\n</section>`
    : '';

  const html = `\n<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8" />\n  <title>${query}</title>\n  <style>\n    body { font-family: "Segoe UI", Arial, sans-serif; line-height: 1.45; }\n    header.cover { text-align: left; margin-bottom: 24px; }\n    .muted { color: #666; }\n    h1, h2, h3 { margin: 18px 0 8px; }\n    p, li { margin: 8px 0; }\n    code { font-family: Consolas, "Courier New", monospace; }\n    pre code { white-space: pre-wrap; word-wrap: break-word; }\n    table { border-collapse: collapse; margin: 12px 0; width: 100%; }\n    th, td { border: 1px solid #ccc; padding: 6px 8px; }\n    blockquote { margin: 10px 0; padding-left: 12px; border-left: 3px solid #ddd; color: #444; }\n    hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }\n    .sources h2, .charts h2 { margin-top: 28px; }\n    a { text-decoration: none; }\n  </style>\n</head>\n<body>\n  <header class="cover">\n    <h1>${query}</h1>\n    <div class="muted">Generated: ${formatLondonDate()}</div>\n  </header>\n\n  ${htmlBody}\n\n  ${chartsHtml}\n\n  <section class="sources">\n    <h2>Sources</h2>\n    ${sourcesHtml}\n  </section>\n</body>\n</html>\n  `;

  const buffer = await HTMLtoDOCX(html);

  const fname = `research-${slugify(query)}-${new Date()
    .toISOString()
    .slice(0, 10)}.docx`;
  const outPath = path.join(outDir, fname);

  await fs.writeFile(outPath, buffer);
  return outPath;
}

// --------------------------- Research plumbing ----------------------------
type SearchResult = {
  title?: string;
  url?: string;
  snippet?: string;
  publishedAt?: string;
  source?: string;
  score?: number;
};

function addPagingHints(
  tool: McpTool,
  args: Record<string, any>,
  topK: number
) {
  const props = (tool.inputSchema as any)?.properties ?? {};
  const numKey = ['count', 'num_results', 'limit', 'n', 'k'].find(
    k => k in props
  );
  if (numKey) args[numKey] = Math.max(topK, 12);
  const freshKey = [
    'recency',
    'freshness_days',
    'days',
    'time_range',
    'recency_days',
  ].find(k => k in props);
  if (freshKey) args[freshKey] = 365;
}

function getItems(raw: string | undefined): any[] {
  if (!raw) return [];

  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let parsed: any = tryParse(raw);

  if (!parsed) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fence) parsed = tryParse(fence);
  }

  const fromParsed = Array.isArray(parsed)
    ? parsed
    : parsed?.results ??
      parsed?.items ??
      parsed?.data ??
      parsed?.web?.results ??
      [];

  if (Array.isArray(fromParsed) && fromParsed.length) return fromParsed;

  const md: any[] = [];
  for (const m of raw.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    md.push({ title: m[1], url: m[2] });
  }
  if (md.length) return md;

  const urls = raw.match(/https?:\/\/[^\s)]+/g) ?? [];
  return urls.map(u => ({ url: u }));
}

type DetailLevel = 'Concise' | 'Detailed' | 'Deep-dive';

function detailTemplate(level: DetailLevel) {
  const targetWords =
    level === 'Deep-dive' ? 1500 : level === 'Detailed' ? 800 : 250;
  const extras =
    level === 'Deep-dive'
      ? [
          '- Add a short timeline if the topic involves events across time.',
          '- Include 3–5 practical recommendations or next steps.',
          '- If there are metrics or rankings, include a Markdown table with at least: Item | Metric | Date/Period | Source [#].',
        ]
      : level === 'Detailed'
      ? [
          '- Provide 4–7 key findings with data points.',
          '- If there are metrics or rankings, include a Markdown table.',
        ]
      : ['- Prioritize the single most important takeaway.'];

  return {
    targetWords,
    instructions: [
      'You are a meticulous research assistant.',
      `Write a ${level.toLowerCase()} but clear answer that a non-expert can understand.`,
      `Target about ${targetWords} words.`,
      'Use ONLY the sources provided; do not invent facts.',
      'Every paragraph that includes a factual claim must include inline numeric citations like [1], [2].',
      'If sources conflict, briefly note the disagreement and cite each side.',
      'Structure your response with Markdown headings where appropriate.',
      '- Begin with an **Executive summary** (bullet points).',
      '- Follow with **Key findings** with inline citations after each bullet.',
      ...extras,
      '- Add **Limitations** and **What to double-check** (actionable checklist).',
      '- End with **Sources** listing the numbered sources provided.',
    ].join(' '),
  };
}

// --------------------------- CLI Handlers ----------------------------
let tools: any[] = [];
let prompts: any[] = [];
let resources: any[] = [];
let resourceTemplates: any[] = [];

async function refreshServerData(
  selectedServer: string,
  mcp: Client | undefined
) {
  if (selectedServer === '__query_all__') {
    let allTools: McpTool[] = [];
    for (const clientName of Object.keys(clients)) {
      try {
        const clientTools = (await clients[clientName].listTools()).tools;
        allTools = allTools.concat(clientTools);
      } catch {}
    }
    tools = allTools;
  } else if (mcp) {
    try {
      tools = (await mcp.listTools()).tools;
    } catch {
      tools = [];
    }
  }
  try {
    prompts =
      (await (mcp ?? clients[Object.keys(clients)[0]]).listPrompts())
        ?.prompts ?? [];
  } catch {
    prompts = [];
  }
  try {
    resources =
      (await (mcp ?? clients[Object.keys(clients)[0]]).listResources())
        ?.resources ?? [];
  } catch {
    resources = [];
  }
  try {
    resourceTemplates =
      (await (mcp ?? clients[Object.keys(clients)[0]]).listResourceTemplates())
        ?.resourceTemplates ?? [];
  } catch {
    resourceTemplates = [];
  }
}

async function handleQueryAllServers(
  allTools: McpTool[],
  toolClientMap: Record<string, Client>
) {
  const query = await input({ message: 'Enter your query' });

  const { text, toolResults } = (await generateText({
    model: google('gemini-2.0-flash'),
    prompt: query,
    tools: allTools.reduce(
      (obj, tool) => ({
        ...obj,
        [tool.name]: {
          description: tool.description,
          parameters: jsonSchema(tool.inputSchema as any),
          execute: async (args: Record<string, any>) => {
            const mcp = toolClientMap[tool.name];
            return await mcp.callTool({ name: tool.name, arguments: args });
          },
        },
      }),
      {} as ToolSet
    ),
  })) as any;

  if (text) {
    console.log(text);
    return;
  }

  if (toolResults?.length) {
    const output =
      toolResults[0]?.result?.content?.[0]?.text || JSON.stringify(toolResults);

    const { text: finalText } = await generateText({
      model: google('gemini-2.0-flash'),
      prompt: MCP_RESULT_PROMPT({ query, output }),
    });

    console.log(finalText || 'No final text generated.');
  }
}

async function handleQuery(mcpTools: McpTool[], mcp: Client) {
  const query = await input({ message: 'Enter your query' });

  const { text, toolResults } = (await generateText({
    model: google('gemini-2.0-flash'),
    prompt: query,
    tools: mcpTools.reduce(
      (obj, tool) => ({
        ...obj,
        [tool.name]: {
          description: tool.description,
          parameters: jsonSchema(tool.inputSchema as any),
          execute: async (args: Record<string, any>) => {
            return await mcp.callTool({ name: tool.name, arguments: args });
          },
        },
      }),
      {} as ToolSet
    ),
  })) as any;

  console.log(
    text || toolResults?.[0]?.result?.content?.[0]?.text || 'No text generated.'
  );
}

async function handleTool(tool: McpTool, mcp: Client) {
  const args: Record<string, string> = {};
  const props = (tool.inputSchema?.properties ?? {}) as Record<
    string,
    { type: string }
  >;
  for (const key of Object.keys(props)) {
    args[key] = await input({
      message: `Enter value for ${key} (${props[key].type}):`,
    });
  }

  const res = await mcp.callTool({ name: tool.name, arguments: args });
  console.log(
    ((res.content as any[])?.[0]?.text as string) ?? JSON.stringify(res)
  );
}

async function handleResource(uri: string, mcp: Client) {
  let finalUri = uri;
  const paramMatches = uri.match(/{([^}]+)}/g);

  if (paramMatches != null) {
    for (const paramMatch of paramMatches) {
      const paramName = paramMatch.replace('{', '').replace('}', '');
      const paramValue = await input({
        message: `Enter value for ${paramName}:`,
      });
      finalUri = finalUri.replace(paramMatch, paramValue);
    }
  }

  const res = await mcp.readResource({ uri: finalUri });
  console.log(
    JSON.stringify(JSON.parse(res.contents[0].text as string), null, 2)
  );
}

async function handlePrompt(prompt: Prompt, mcp: Client) {
  const args: Record<string, string> = {};
  for (const arg of prompt.arguments ?? []) {
    args[arg.name] = await input({ message: `Enter value for ${arg.name}:` });
  }

  const response = await mcp.getPrompt({ name: prompt.name, arguments: args });

  for (const message of response.messages) {
    console.log(await handleServerMessagePrompt(message));
  }
}

async function handleServerMessagePrompt(message: PromptMessage) {
  if (message.content.type !== 'text') return;

  console.log(message.content.text);
  const run = await confirm({
    message: 'Would you like to run the above prompt',
    default: true,
  });

  if (!run) return;

  const { text } = await generateText({
    model: google('gemini-2.0-flash'),
    prompt: message.content.text,
  });
  return text;
}

async function handleResearch(mcp: Client) {
  const query = await input({ message: chalk.blue('What should I research?') });

  const defaultDepth =
    (process.env.RESEARCH_DEFAULT_DEPTH as DetailLevel) || 'Detailed';
  const depth = await select<DetailLevel>({
    message: chalk.blue('How detailed should the answer be?'),
    choices: [
      { name: 'Concise (~250 words)', value: 'Concise' },
      { name: 'Detailed (~800 words)', value: 'Detailed' },
      { name: 'Deep-dive (~1500 words)', value: 'Deep-dive' },
    ],
    default: defaultDepth,
  });

  const spinner = ora(chalk.yellow('Collecting search tools...')).start();

  // Collect search tools from the selected client
  let searchTools: McpTool[] = [];
  try {
    const listed = await mcp.listTools();
    searchTools = listed.tools.filter(t => {
      const n = (t.name || '').toLowerCase();
      const d = (t.description || '').toLowerCase();
      return (
        n.includes('search') ||
        d.includes('search the web') ||
        d.includes('web search')
      );
    });
  } catch {}

  if (searchTools.length === 0) {
    // Try all clients as fallback
    for (const clientName of Object.keys(clients)) {
      try {
        const listed = await clients[clientName].listTools();
        searchTools.push(
          ...listed.tools.filter(t => {
            const n = (t.name || '').toLowerCase();
            const d = (t.description || '').toLowerCase();
            return (
              n.includes('search') ||
              d.includes('search the web') ||
              d.includes('web search')
            );
          })
        );
      } catch {}
    }
  }
  spinner.succeed(chalk.green(`Found ${searchTools.length} search tool(s).`));

  const topKStr = await input({
    message: chalk.blue('How many top results to use? (default 6)'),
  });
  const topK = Math.max(1, Number(topKStr) || 6);

  const results: SearchResult[] = [];

  const findQueryProp = (tool: McpTool) => {
    const props = (tool.inputSchema as any)?.properties ?? {};
    const keys = Object.keys(props);
    if (keys.includes('query')) return 'query';
    if (keys.includes('q')) return 'q';
    for (const k of keys) {
      if ((props[k] as any).type === 'string') return k;
    }
    return keys[0];
  };

  const toolSpinner = ora(chalk.yellow('Searching the web...')).start();
  let searchSuccess = false;

  for (const tool of searchTools) {
    try {
      const qKey = findQueryProp(tool);
      const args: Record<string, any> = {};
      args[qKey] = query;
      addPagingHints(tool, args, topK);

      const res = await mcp.callTool({ name: tool.name, arguments: args });
      const content = (res.content as any[])?.[0];
      const raw =
        content?.text ?? (content?.type === 'text' ? content.text : undefined);
      const items: any[] = getItems(raw);

      if (Array.isArray(items) && items.length) {
        for (const it of items) {
          results.push({
            title: it.title ?? it.name ?? it.heading ?? undefined,
            url: it.url ?? it.link ?? it.permalink ?? undefined,
            snippet: it.snippet ?? it.description ?? it.summary ?? undefined,
            publishedAt: it.publishedAt ?? it.date ?? it.published ?? undefined,
            source: it.source ?? it.site ?? it.domain ?? undefined,
            score: it.score ?? it.rating ?? undefined,
          });
        }
        searchSuccess = true;
      }
    } catch {
      // ignore individual tool errors
    }
  }

  if (searchSuccess) {
    toolSpinner.succeed(chalk.green('Search complete.'));
  } else {
    toolSpinner.fail(chalk.red('Search failed.'));
  }

  // Dedupe by URL/title
  const deduped: SearchResult[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const key = (r.url || r.title || JSON.stringify(r)).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
    }
  }

  const top = deduped.slice(0, topK);

  if (top.length === 0) {
    console.log(chalk.red('\n===== Research Answer =====\n'));
    console.log(
      chalk.red(
        "I couldn't extract any web results from the search tools. Try a more specific query or check your Brave API key.\n"
      )
    );
    console.log(
      chalk.yellow(
        "Tips:\n- Use precise terms (e.g., 'Gartner 2024 semiconductor revenue share').\n- Increase the result count if your tool supports it.\n- Verify the Brave MCP server is running with a valid BRAVE_API_KEY.\n"
      )
    );
    console.log(chalk.red('===== End =====\n'));
    return;
  }

  // Build citations list
  const sourcesBlock = top
    .map((r, i) => {
      const host = (() => {
        try {
          return new URL(r.url || '').hostname.replace(/^www\./, '');
        } catch {
          return r.source || '';
        }
      })();
      const date = r.publishedAt ? ` (${r.publishedAt})` : '';
      return `[${i + 1}] ${r.title || r.url} — ${host}${date}\n${r.url || ''}`;
    })
    .join('\n\n');

  const { targetWords, instructions } = detailTemplate(depth);

  const system = [
    instructions,
    "If a simple chart (bar/line/pie) would improve clarity, call the appropriate chart tool with the exact numeric data you're citing.",
    'Prefer small, tidy datasets (≤10 categories). Name datasets clearly.',
    'For comparisons over time, use line/bar; for shares, use pie/doughnut; for 2–3 groups vs categories, use the multi-dataset tool.',
    'After creating a chart, continue your answer as normal.',
    'If you cannot extract reliable numbers, do not fabricate charts.',
  ].join(' ');

  const generationSpinner = ora(chalk.yellow('Synthesizing answer...')).start();

  const generatedCharts: GeneratedChart[] = [];
  const chartToolset = buildChartToolset(generatedCharts);

  const { text } = await generateText({
    model: google('gemini-2.0-flash'),
    prompt: `SYSTEM:\n${system}\n\nUSER QUERY:\n${query}\n\nSEARCH RESULTS (use as your only sources):\n${sourcesBlock}\n\nRespond in Markdown and aim for about ${targetWords} words.`,
    tools: chartToolset,
  });
  generationSpinner.succeed(chalk.green('Answer generated.'));

  console.log(chalk.green('\n===== Research Answer =====\n'));
  console.log(text || chalk.red('No answer generated.'));
  console.log(chalk.green('\n===== End =====\n'));

  // Build and embed charts into DOCX
  const chartsForDocx: Array<{
    title?: string;
    dataUri: string;
    explanationMd: string;
    alt?: string;
  }> = [];
  for (const ch of generatedCharts) {
    try {
      const [dataUri, explanationMd] = await Promise.all([
        fetchAsDataUri(ch.url),
        explainChart(ch.args, ch.type),
      ]);
      chartsForDocx.push({
        title: ch.title,
        dataUri,
        explanationMd,
        alt: ch.title || `Chart: ${ch.type}`,
      });
    } catch (e) {
      console.error(
        chalk.yellow(`Skipping chart (failed to embed/explain): ${ch.url}`)
      );
    }
  }

  try {
    if (text) {
      const outPath = await saveResearchAsDocx({
        query,
        markdown: text,
        sourcesBlock,
        charts: chartsForDocx,
      });
      console.log(chalk.green(`\n📄 Word document saved: ${outPath}\n`));
    } else {
      console.log(chalk.yellow('Skipped DOCX export (no text).'));
    }
  } catch (err) {
    console.error(chalk.red('Failed to create DOCX:'), err);
  }
}

// --------------------------- Main ----------------------------
async function main() {
  // Connect to all servers
  for (const config of serverConfigs) {
    const client = new Client(
      { name: config.name, version: '1.0.0' },
      { capabilities: { sampling: {} } }
    );

    let transport:
      | StdioClientTransport
      | StreamableHTTPClientTransport
      | undefined;
    if (config.type === 'stdio') {
      transport = new StdioClientTransport({
        command: config.command ?? '',
        args: config.args,
        env: config.env,
        stderr: 'ignore',
      });
    } else if (config.type === 'http') {
      transport = new StreamableHTTPClientTransport(new URL(config.url!));
    } else {
      throw new Error(`Unknown transport type: ${config.type}`);
    }

    await client.connect(transport);
    clients[config.name] = client;
    transports[config.name] = transport;
  }

  // Default: first client (even when querying all)
  let selectedServer = await select({
    message: 'Select MCP server',
    choices: [
      { name: 'Query All Servers', value: '__query_all__' },
      ...serverConfigs.map(cfg => ({ name: cfg.name, value: cfg.name })),
    ],
  });

  let mcp: Client =
    selectedServer === '__query_all__'
      ? clients[Object.keys(clients)[0]]
      : clients[selectedServer];

  await refreshServerData(selectedServer, mcp);

  mcp.setRequestHandler(CreateMessageRequestSchema, async request => {
    const texts: string[] = [];
    for (const message of request.params.messages) {
      const text = await handleServerMessagePrompt(message);
      if (text != null) texts.push(text);
    }

    return {
      role: 'user',
      model: 'gemini-2.0-flash',
      stopReason: 'endTurn',
      content: { type: 'text' as const, text: texts.join('\n') },
    } as any;
  });

  console.log('You are connected!');

  while (true) {
    const menuChoices: string[] = ['Query', 'Research (Web + AI)'];
    if (tools.length > 0) menuChoices.push('Tools');
    if (resources.length > 0 || resourceTemplates.length > 0)
      menuChoices.push('Resources');
    if (prompts.length > 0) menuChoices.push('Prompts');
    menuChoices.push('Switch Server');

    const option = await select({
      message: `What would you like to do (Server: ${selectedServer})`,
      choices: menuChoices,
    });

    switch (option) {
      case 'Switch Server': {
        selectedServer = await select({
          message: 'Select MCP server',
          choices: [
            { name: 'Query All Servers', value: '__query_all__' },
            ...serverConfigs.map(cfg => ({ name: cfg.name, value: cfg.name })),
          ],
        });
        if (selectedServer === '__query_all__') {
          // Aggregate all tools and map to clients
          let allTools: McpTool[] = [];
          const toolClientMap: Record<string, Client> = {};
          for (const clientName of Object.keys(clients)) {
            try {
              const clientTools = (await clients[clientName].listTools()).tools;
              for (const tool of clientTools) {
                allTools.push(tool);
                toolClientMap[tool.name] = clients[clientName];
              }
            } catch {}
          }
          await handleQueryAllServers(allTools, toolClientMap);
        } else {
          mcp = clients[selectedServer];
          await refreshServerData(selectedServer, mcp);
        }
        break;
      }

      case 'Tools': {
        if (!mcp) break;
        const toolName = await select({
          message: 'Select a tool',
          choices: tools.map((tool: McpTool) => ({
            name: (tool.annotations as any)?.title || tool.name,
            value: tool.name,
            description: tool.description,
          })),
        });
        const tool = tools.find((t: McpTool) => t.name === toolName) as
          | McpTool
          | undefined;
        if (!tool) {
          console.error('Tool not found.');
        } else {
          await handleTool(tool, mcp);
        }
        break;
      }

      case 'Resources': {
        if (!mcp) break;
        const resourceUri = await select({
          message: 'Select a resource',
          choices: [
            ...resources.map((resource: any) => ({
              name: resource.name,
              value: resource.uri,
              description: resource.description,
            })),
            ...resourceTemplates.map((template: any) => ({
              name: template.name,
              value: template.uriTemplate,
              description: template.description,
            })),
          ],
        });
        const uri =
          resources.find((r: any) => r.uri === resourceUri)?.uri ??
          resourceTemplates.find((r: any) => r.uriTemplate === resourceUri)
            ?.uriTemplate;
        if (!uri) {
          console.error('Resource not found.');
        } else {
          await handleResource(uri, mcp);
        }
        break;
      }

      case 'Prompts': {
        if (!mcp) break;
        const promptName = await select({
          message: 'Select a prompt',
          choices: prompts.map((prompt: Prompt) => ({
            name: prompt.name,
            value: prompt.name,
            description: prompt.description,
          })),
        });
        const prompt = prompts.find((p: Prompt) => p.name === promptName) as
          | Prompt
          | undefined;
        if (!prompt) {
          console.error('Prompt not found.');
        } else {
          await handlePrompt(prompt, mcp);
        }
        break;
      }

      case 'Research (Web + AI)': {
        await handleResearch(mcp);
        break;
      }

      case 'Query': {
        if (selectedServer === '__query_all__') {
          // Aggregate all tools and map to clients
          let allTools: McpTool[] = [];
          const toolClientMap: Record<string, Client> = {};
          for (const clientName of Object.keys(clients)) {
            try {
              const clientTools = (await clients[clientName].listTools()).tools;
              for (const tool of clientTools) {
                allTools.push(tool);
                toolClientMap[tool.name] = clients[clientName];
              }
            } catch {}
          }
          await handleQueryAllServers(allTools, toolClientMap);
        } else {
          if (!mcp) break;
          await handleQuery(tools as McpTool[], mcp);
        }
        break;
      }
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
