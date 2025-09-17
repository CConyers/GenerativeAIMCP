import 'dotenv/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { confirm, input, select } from '@inquirer/prompts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CreateMessageRequestSchema,
  Prompt,
  PromptMessage,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { generateText, jsonSchema, ToolSet } from 'ai';
import chalk from 'chalk'; // Import chalk for colored output
import ora from 'ora'; // Import ora for a loading spinner

/**
 * MCP-powered Web Research + AI synthesis CLI
 * - Connects to Brave Search MCP server (real-time web)
 * - Normalizes results (JSON, code fences, markdown links, bare URLs)
 * - Synthesizes an answer with inline numeric citations [1][2]
 * - NEW: Detail level selector (Concise / Detailed / Deep-dive) & richer structure
 */

const serverConfigs = [
  {
    name: 'Brave Search',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: {
      BRAVE_API_KEY: process.env.BRAVE_API_KEY || '',
    },
  },
  {
    name: 'Filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', './'],
  },
];

const clients: Record<string, Client> = {};
const transports: Record<string, StdioClientTransport> = {};

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});

async function main() {
  // Connect to all servers
  for (const config of serverConfigs) {
    const client = new Client(
      {
        name: config.name,
        version: '1.0.0',
      },
      { capabilities: { sampling: {} } }
    );
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      stderr: 'ignore',
    });
    await client.connect(transport);
    clients[config.name] = client;
    transports[config.name] = transport;
  }

  // Select which server to use
  let selectedServer = await select({
    message: 'Select MCP server',
    choices: [
      { name: 'Query All Servers', value: '__query_all__' },
      ...serverConfigs.map(cfg => ({ name: cfg.name, value: cfg.name })),
    ],
  });
  // Always set mcp to a valid client (default to first client if needed)
  let mcp: Client =
    selectedServer === '__query_all__'
      ? clients[Object.keys(clients)[0]]
      : clients[selectedServer];

  let tools: any[] = [];
  let prompts: any[] = [];
  let resources: any[] = [];
  let resourceTemplates: any[] = [];

  async function refreshServerData() {
    try {
      tools = (await mcp.listTools()).tools;
    } catch {
      tools = [];
    }
    try {
      prompts = (await mcp.listPrompts())?.prompts ?? [];
    } catch {
      prompts = [];
    }
    try {
      resources = (await mcp.listResources())?.resources ?? [];
    } catch {
      resources = [];
    }
    try {
      resourceTemplates =
        (await mcp.listResourceTemplates())?.resourceTemplates ?? [];
    } catch {
      resourceTemplates = [];
    }
  }

  await refreshServerData();

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
      content: {
        type: 'text',
        text: texts.join('\n'),
      },
    };
  });

  console.log('You are connected!');
  while (true) {
    const menuChoices = ['Query', 'Research (Web + AI)'];
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
      case 'Query All Servers':
        // Aggregate all tools from all clients
        let allTools: Tool[] = [];
        for (const clientName of Object.keys(clients)) {
          try {
            const clientTools = (await clients[clientName].listTools()).tools;
            allTools = allTools.concat(clientTools);
          } catch {}
        }
        await handleQuery(allTools, mcp);
        break;
      case 'Switch Server':
        selectedServer = await select({
          message: 'Select MCP server',
          choices: [
            { name: 'Query All Servers', value: '__query_all__' },
            ...serverConfigs.map(cfg => ({ name: cfg.name, value: cfg.name })),
          ],
        });
        if (selectedServer === '__query_all__') {
          // Aggregate all tools from all clients
          let allTools2: Tool[] = [];
          for (const clientName of Object.keys(clients)) {
            try {
              const clientTools = (await clients[clientName].listTools()).tools;
              allTools2 = allTools2.concat(clientTools);
            } catch {}
          }
          // Use the first available client for tool execution context
          const firstClient = clients[Object.keys(clients)[0]];
          await handleQuery(allTools2, firstClient);
        } else {
          mcp = clients[selectedServer];
          await refreshServerData();
        }
        break;
      case 'Tools':
        if (!mcp) break;
        const toolName = await select({
          message: 'Select a tool',
          choices: tools.map(tool => ({
            name: tool.annotations?.title || tool.name,
            value: tool.name,
            description: tool.description,
          })),
        });
        const tool = tools.find(t => t.name === toolName);
        if (tool == null) {
          console.error('Tool not found.');
        } else {
          await handleTool(tool, mcp);
        }
        break;
      case 'Resources':
        if (!mcp) break;
        const resourceUri = await select({
          message: 'Select a resource',
          choices: [
            ...resources.map(resource => ({
              name: resource.name,
              value: resource.uri,
              description: resource.description,
            })),
            ...resourceTemplates.map(template => ({
              name: template.name,
              value: template.uriTemplate,
              description: template.description,
            })),
          ],
        });
        const uri =
          resources.find(r => r.uri === resourceUri)?.uri ??
          resourceTemplates.find(r => r.uriTemplate === resourceUri)
            ?.uriTemplate;
        if (uri == null) {
          console.error('Resource not found.');
        } else {
          await handleResource(uri, mcp);
        }
        break;
      case 'Prompts':
        if (!mcp) break;
        const promptName = await select({
          message: 'Select a prompt',
          choices: prompts.map(prompt => ({
            name: prompt.name,
            value: prompt.name,
            description: prompt.description,
          })),
        });
        const prompt = prompts.find(p => p.name === promptName);
        if (prompt == null) {
          console.error('Prompt not found.');
        } else {
          await handlePrompt(prompt, mcp);
        }
        break;
      case 'Research (Web + AI)':
        await handleResearch(mcp);
        break;
      case 'Query':
        if (!mcp) break;
        await handleQuery(tools, mcp);
    }
  }
}

async function handleQuery(tools: Tool[], mcp: Client) {
  const query = await input({ message: 'Enter your query' });

  const { text, toolResults } = await generateText({
    model: google('gemini-2.0-flash'),
    prompt: query,
    tools: tools.reduce(
      (obj, tool) => ({
        ...obj,
        [tool.name]: {
          description: tool.description,
          parameters: jsonSchema(tool.inputSchema as any),
          execute: async (args: Record<string, any>) => {
            return await mcp.callTool({
              name: tool.name,
              arguments: args,
            });
          },
        },
      }),
      {} as ToolSet
    ),
  });

  console.log(
    // @ts-expect-error
    text || toolResults[0]?.result?.content[0]?.text || 'No text generated.'
  );
}

async function handleTool(tool: Tool, mcp: Client) {
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    tool.inputSchema.properties ?? {}
  )) {
    args[key] = await input({
      message: `Enter value for ${key} (${(value as { type: string }).type}):`,
    });
  }

  const res = await mcp.callTool({
    name: tool.name,
    arguments: args,
  });

  console.log((res.content as [{ text: string }])[0].text);
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

  const res = await mcp.readResource({
    uri: finalUri,
  });

  console.log(
    JSON.stringify(JSON.parse(res.contents[0].text as string), null, 2)
  );
}

async function handlePrompt(prompt: Prompt, mcp: Client) {
  const args: Record<string, string> = {};
  for (const arg of prompt.arguments ?? []) {
    args[arg.name] = await input({
      message: `Enter value for ${arg.name}:`,
    });
  }

  const response = await mcp.getPrompt({
    name: prompt.name,
    arguments: args,
  });

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

// --- Web Research workflow with robust parsing + paging hints + detail levels ---
type SearchResult = {
  title?: string;
  url?: string;
  snippet?: string;
  publishedAt?: string;
  source?: string;
  score?: number;
};

/** Add optional paging/recency hints if the tool supports them */
function addPagingHints(tool: Tool, args: Record<string, any>, topK: number) {
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
  if (freshKey) args[freshKey] = 365; // last year if supported
}

/** Normalize raw text into an array of {title,url,...} items */
function getItems(raw: string | undefined): any[] {
  if (!raw) return [];

  // Try direct JSON
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let parsed = tryParse(raw);

  // Try code-fenced JSON
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

  // Try markdown links: [text](url)
  const md: any[] = [];
  for (const m of raw.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    md.push({ title: m[1], url: m[2] });
  }
  if (md.length) return md;

  // Bare URLs
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

async function handleResearch(mcp: Client) {
  const query = await input({ message: chalk.blue('What should I research?') });

  // Detail level selection (with env default)
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

  // Collect search tools from the selected client (fallback: all clients)
  let searchTools: Tool[] = [];
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
    // Try all clients
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

  // Helper to find likely query property
  const findQueryProp = (tool: Tool) => {
    const props = (tool.inputSchema as any)?.properties ?? {};
    const keys = Object.keys(props);
    if (keys.includes('query')) return 'query';
    if (keys.includes('q')) return 'q';
    // first string prop
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

      const content = (res.content as any[])[0];
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
        "I couldn't extract any web results from the search tools. Try a more specific query (e.g., add vendor/year/source) or check your Brave API key.\n"
      )
    );
    console.log(
      chalk.yellow(
        "Tips:\n- Use precise terms (e.g., 'Gartner 2024 semiconductor revenue share top 10 final figures').\n- Increase the result count if your tool supports it.\n- Verify the Brave MCP server is running with a valid BRAVE_API_KEY.\n"
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
    "If the query requests 'percentages' or 'shares', include exact % and period (e.g., FY2024) and cite immediately after each figure.",
    'For lists (top X), include a table with rank.',
  ].join(' ');

  const generationSpinner = ora(chalk.yellow('Synthesizing answer...')).start();
  const { text } = await generateText({
    model: google('gemini-2.0-flash'),
    prompt: `SYSTEM:\n${system}

USER QUERY:
${query}

SEARCH RESULTS (use as your only sources):
${sourcesBlock}

Respond in Markdown and aim for about ${targetWords} words.`,
  });

  generationSpinner.succeed(chalk.green('Answer generated.'));

  console.log(chalk.green('\n===== Research Answer =====\n'));
  console.log(text || chalk.red('No answer generated.'));
  console.log(chalk.green('\n===== End =====\n'));
}

main();
