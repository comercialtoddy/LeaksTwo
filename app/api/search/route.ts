// /app/api/chat/route.ts
import { getGroupConfig } from '@/app/actions';
import { serverEnv } from '@/env/server';
import { xai } from '@ai-sdk/xai';
import { groq } from "@ai-sdk/groq";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import CodeInterpreter from '@e2b/code-interpreter';
import { Daytona, ChartType, SandboxTargetRegion } from '@daytonaio/sdk';
import { tavily } from '@tavily/core';
import {
    convertToCoreMessages,
    smoothStream,
    streamText,
    tool,
    createDataStreamResponse,
    customProvider,
    generateObject,
    NoSuchToolError,
    extractReasoningMiddleware,
    wrapLanguageModel
} from 'ai';
import Exa from 'exa-js';
import { z } from 'zod';
import MemoryClient from 'mem0ai';

// Add currency symbol mapping at the top of the file
const CURRENCY_SYMBOLS = {
    USD: '$',   // US Dollar
    EUR: '€',   // Euro
    GBP: '£',   // British Pound
    JPY: '¥',   // Japanese Yen
    CNY: '¥',   // Chinese Yuan
    INR: '₹',   // Indian Rupee
    RUB: '₽',   // Russian Ruble
    KRW: '₩',   // South Korean Won
    BTC: '₿',   // Bitcoin
    THB: '฿',   // Thai Baht
    BRL: 'R$',  // Brazilian Real
    PHP: '₱',   // Philippine Peso
    ILS: '₪',   // Israeli Shekel
    TRY: '₺',   // Turkish Lira
    NGN: '₦',   // Nigerian Naira
    VND: '₫',   // Vietnamese Dong
    ARS: '$',   // Argentine Peso
    ZAR: 'R',   // South African Rand
    AUD: 'A$',  // Australian Dollar
    CAD: 'C$',  // Canadian Dollar
    SGD: 'S$',  // Singapore Dollar
    HKD: 'HK$', // Hong Kong Dollar
    NZD: 'NZ$', // New Zealand Dollar
    MXN: 'Mex$' // Mexican Peso
} as const;

const middleware = extractReasoningMiddleware({
    tagName: 'think',
});

const scira = customProvider({
    languageModels: {
        'scira-default': xai("grok-3-mini"),
        'scira-grok-3': xai('grok-3-beta'),
        'scira-vision': xai('grok-2-vision-1212'),
        'scira-4o': openai('gpt-4o', {
            structuredOutputs: true,
        }),
        'scira-o4-mini': openai.responses('o4-mini-2025-04-16'),
        'scira-qwq': wrapLanguageModel({
            model: groq('qwen-qwq-32b'),
            middleware,
        }),
        'scira-google': google('gemini-2.5-flash-preview-04-17', {
            structuredOutputs: true,
        }),
        'scira-google-pro': google('gemini-2.5-pro-preview-05-06', {
            structuredOutputs: true,
        }),
        'scira-anthropic': anthropic('claude-3-7-sonnet-20250219'),
        'scira-llama-4': groq('meta-llama/llama-4-maverick-17b-128e-instruct', {
            parallelToolCalls: false,
        }),
    }
})

interface MapboxFeature {
    id: string;
    name: string;
    formatted_address: string;
    geometry: {
        type: string;
        coordinates: number[];
    };
    feature_type: string;
    context: string;
    coordinates: number[];
    bbox: number[];
    source: string;
}

interface GoogleResult {
    place_id: string;
    formatted_address: string;
    geometry: {
        location: {
            lat: number;
            lng: number;
        };
        viewport: {
            northeast: {
                lat: number;
                lng: number;
            };
            southwest: {
                lat: number;
                lng: number;
            };
        };
    };
    types: string[];
    address_components: Array<{
        long_name: string;
        short_name: string;
        types: string[];
    }>;
}

interface VideoDetails {
    title?: string;
    author_name?: string;
    author_url?: string;
    thumbnail_url?: string;
    type?: string;
    provider_name?: string;
    provider_url?: string;
}

interface VideoResult {
    videoId: string;
    url: string;
    details?: VideoDetails;
    captions?: string;
    timestamps?: string[];
    views?: string;
    likes?: string;
    summary?: string;
}

function sanitizeUrl(url: string): string {
    return url.replace(/\s+/g, '%20');
}

async function isValidImageUrl(url: string): Promise<{ valid: boolean; redirectedUrl?: string }> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(url, {
            method: 'HEAD',
            signal: controller.signal,
            headers: {
                'Accept': 'image/*',
                'User-Agent': 'Mozilla/5.0 (compatible; ImageValidator/1.0)'
            },
            redirect: 'follow' // Ensure redirects are followed
        });

        clearTimeout(timeout);

        // Log response details for debugging
        console.log(`Image validation [${url}]: status=${response.status}, content-type=${response.headers.get('content-type')}`);

        // Capture redirected URL if applicable
        const redirectedUrl = response.redirected ? response.url : undefined;

        // Check if we got redirected (for logging purposes)
        if (response.redirected) {
            console.log(`Image was redirected from ${url} to ${redirectedUrl}`);
        }

        // Handle specific response codes
        if (response.status === 404) {
            console.log(`Image not found (404): ${url}`);
            return { valid: false };
        }

        if (response.status === 403) {
            console.log(`Access forbidden (403) - likely CORS issue: ${url}`);

            // Try to use proxy instead of whitelisting domains
            try {
                // Attempt to handle CORS blocked images by trying to access via proxy
                const controller = new AbortController();
                const proxyTimeout = setTimeout(() => controller.abort(), 5000);

                const proxyResponse = await fetch(`/api/proxy-image?url=${encodeURIComponent(url)}`, {
                    method: 'HEAD',
                    signal: controller.signal
                });

                clearTimeout(proxyTimeout);

                if (proxyResponse.ok) {
                    const contentType = proxyResponse.headers.get('content-type');
                    const proxyRedirectedUrl = proxyResponse.headers.get('x-final-url') || undefined;

                    if (contentType && contentType.startsWith('image/')) {
                        console.log(`Proxy validation successful for ${url}`);
                        return {
                            valid: true,
                            redirectedUrl: proxyRedirectedUrl || redirectedUrl
                        };
                    }
                }
            } catch (proxyError) {
                console.error(`Proxy validation failed for ${url}:`, proxyError);
            }
            return { valid: false };
        }

        if (response.status >= 400) {
            console.log(`Image request failed with status ${response.status}: ${url}`);
            return { valid: false };
        }

        // Check content type to ensure it's actually an image
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.startsWith('image/')) {
            console.log(`Invalid content type for image: ${contentType}, url: ${url}`);
            return { valid: false };
        }

        return { valid: true, redirectedUrl };
    } catch (error) {
        // Check if error is related to CORS
        const errorMsg = error instanceof Error ? error.message : String(error);

        if (errorMsg.includes('CORS') || errorMsg.includes('blocked by CORS policy')) {
            console.error(`CORS error for ${url}:`, errorMsg);

            // Try to use proxy instead of whitelisting domains
            try {
                // Attempt to handle CORS blocked images by trying to access via proxy
                const controller = new AbortController();
                const proxyTimeout = setTimeout(() => controller.abort(), 5000);

                const proxyResponse = await fetch(`/api/proxy-image?url=${encodeURIComponent(url)}`, {
                    method: 'HEAD',
                    signal: controller.signal
                });

                clearTimeout(proxyTimeout);

                if (proxyResponse.ok) {
                    const contentType = proxyResponse.headers.get('content-type');
                    const proxyRedirectedUrl = proxyResponse.headers.get('x-final-url') || undefined;

                    if (contentType && contentType.startsWith('image/')) {
                        console.log(`Proxy validation successful for ${url}`);
                        return { valid: true, redirectedUrl: proxyRedirectedUrl };
                    }
                }
            } catch (proxyError) {
                console.error(`Proxy validation failed for ${url}:`, proxyError);
            }
        }

        // Log the specific error
        console.error(`Image validation error for ${url}:`, errorMsg);
        return { valid: false };
    }
}


const extractDomain = (url: string): string => {
    const urlPattern = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i;
    return url.match(urlPattern)?.[1] || url;
};

const deduplicateByDomainAndUrl = <T extends { url: string }>(items: T[]): T[] => {
    const seenDomains = new Set<string>();
    const seenUrls = new Set<string>();

    return items.filter(item => {
        const domain = extractDomain(item.url);
        const isNewUrl = !seenUrls.has(item.url);
        const isNewDomain = !seenDomains.has(domain);

        if (isNewUrl && isNewDomain) {
            seenUrls.add(item.url);
            seenDomains.add(domain);
            return true;
        }
        return false;
    });
};

// Initialize Exa client
const exa = new Exa(serverEnv.EXA_API_KEY);

// Add interface for Exa search results
interface ExaResult {
    title: string;
    url: string;
    publishedDate?: string;
    author?: string;
    score?: number;
    id: string;
    image?: string;
    favicon?: string;
    text: string;
    highlights?: string[];
    highlightScores?: number[];
    summary?: string;
    subpages?: ExaResult[];
    extras?: {
        links: any[];
    };
}

// Modify the POST function to use the new handler
export async function POST(req: Request) {
    const { messages, model, group, user_id, timezone } = await req.json();
    const { tools: activeTools, instructions } = await getGroupConfig(group);

    console.log("--------------------------------");
    console.log("Messages: ", messages);
    console.log("--------------------------------");
    console.log("Running with model: ", model.trim());
    console.log("Group: ", group);
    console.log("Timezone: ", timezone);

    return createDataStreamResponse({
        execute: async (dataStream) => {
            const result = streamText({
                model: scira.languageModel(model),
                messages: convertToCoreMessages(messages),
                ...(model !== 'scira-o4-mini' || model !== 'scira-anthropic' ? {
                    temperature: 0,
                } : {}),
                maxSteps: 5,
                experimental_activeTools: [...activeTools],
                system: instructions,
                toolChoice: 'auto',
                experimental_transform: smoothStream({
                    chunking: 'word',
                    delayInMs: 15,
                }),
                providerOptions: {
                    scira: {
                        ...(model === 'scira-default' ?
                            {
                                reasoningEffort: 'high',
                            }
                            : {}
                        ),
                        ...(model === 'scira-o4-mini' ? {
                            reasoningEffort: 'medium'
                        } : {}),
                        ...(model === 'scira-google' ? {
                            thinkingConfig: {
                                thinkingBudget: 10000,
                            },
                        } : {}),
                    },
                    google: {
                        thinkingConfig: {
                            thinkingBudget: 10000,
                        },
                    },
                    openai: {
                        ...(model === 'scira-o4-mini' ? {
                            reasoningEffort: 'medium'
                        } : {})
                    },
                    xai: {
                        ...(model === 'scira-default' ? {
                            reasoningEffort: 'high',
                        } : {}),
                    },
                    anthropic: {
                        thinking: { type: 'enabled', budgetTokens: 12000 },
                    }
                },
                tools: {
                    stock_chart: tool({
                        description: 'Get stock data and news for given stock symbols.',
                        parameters: z.object({
                            title: z.string().describe('The title of the chart.'),
                            news_queries: z.array(z.string()).describe('The news queries to search for.'),
                            icon: z
                                .enum(['stock', 'date', 'calculation', 'default'])
                                .describe('The icon to display for the chart.'),
                            stock_symbols: z.array(z.string()).describe('The stock symbols to display for the chart.'),
                            currency_symbols: z.array(z.string()).describe('The currency symbols for each stock/asset in the chart. Available symbols: ' + Object.keys(CURRENCY_SYMBOLS).join(', ') + '. Defaults to USD if not provided.'),
                            interval: z.enum(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']).describe('The interval of the chart. default is 1y.'),
                        }),
                        execute: async ({ title, icon, stock_symbols, currency_symbols, interval, news_queries }: { title: string; icon: string; stock_symbols: string[]; currency_symbols?: string[]; interval: string; news_queries: string[] }) => {
                            console.log('Title:', title);
                            console.log('Icon:', icon);
                            console.log('Stock symbols:', stock_symbols);
                            console.log('Currency symbols:', currency_symbols);
                            console.log('Interval:', interval);
                            console.log('News queries:', news_queries);

                            // Format currency symbols with actual symbols
                            const formattedCurrencySymbols = (currency_symbols || stock_symbols.map(() => 'USD')).map(currency => {
                                const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS];
                                return symbol || currency; // Fallback to currency code if symbol not found
                            });

                            interface NewsResult {
                                title: string;
                                url: string;
                                content: string;
                                published_date?: string;
                                category: string;
                                query: string;
                            }

                            interface NewsGroup {
                                query: string;
                                topic: string;
                                results: NewsResult[];
                            }

                            let news_results: NewsGroup[] = [];

                            const tvly = tavily({ apiKey: serverEnv.TAVILY_API_KEY });

                            // Gather all news search promises to execute in parallel
                            const searchPromises = [];
                            for (const query of news_queries) {
                                // Add finance and news topic searches for each query
                                searchPromises.push({
                                    query,
                                    topic: 'finance',
                                    promise: tvly.search(query, {
                                        topic: 'finance',
                                        days: 7,
                                        maxResults: 3,
                                        searchDepth: 'advanced',
                                    })
                                });

                                searchPromises.push({
                                    query,
                                    topic: 'news',
                                    promise: tvly.search(query, {
                                        topic: 'news',
                                        days: 7,
                                        maxResults: 3,
                                        searchDepth: 'advanced',
                                    })
                                });
                            }

                            // Execute all searches in parallel
                            const searchResults = await Promise.all(
                                searchPromises.map(({ promise }) => promise.catch(err => ({
                                    results: [],
                                    error: err.message
                                })))
                            );

                            // Process results and deduplicate
                            const urlSet = new Set();
                            searchPromises.forEach(({ query, topic }, index) => {
                                const result = searchResults[index];
                                if (!result.results) return;

                                const processedResults = result.results
                                    .filter(item => {
                                        // Skip if we've already included this URL
                                        if (urlSet.has(item.url)) return false;
                                        urlSet.add(item.url);
                                        return true;
                                    })
                                    .map(item => ({
                                        title: item.title,
                                        url: item.url,
                                        content: item.content.slice(0, 30000),
                                        published_date: item.publishedDate,
                                        category: topic,
                                        query: query
                                    }));

                                if (processedResults.length > 0) {
                                    news_results.push({
                                        query,
                                        topic,
                                        results: processedResults
                                    });
                                }
                            });

                            // Perform Exa search for financial reports
                            const exaResults: NewsGroup[] = [];
                            try {
                                // Run Exa search for each stock symbol
                                const exaSearchPromises = stock_symbols.map(symbol =>
                                    exa.searchAndContents(
                                        `${symbol} financial report analysis`,
                                        {
                                            text: true,
                                            category: "financial report",
                                            livecrawl: "always",
                                            type: "auto",
                                            numResults: 10,
                                            summary: {
                                                query: "all important information relevent to the important for investors"
                                            }
                                        }
                                    ).catch(error => {
                                        console.error(`Exa search error for ${symbol}:`, error);
                                        return { results: [] };
                                    })
                                );

                                const exaSearchResults = await Promise.all(exaSearchPromises);

                                // Process Exa results
                                const exaUrlSet = new Set();
                                exaSearchResults.forEach((result, index) => {
                                    if (!result.results || result.results.length === 0) return;

                                    const stockSymbol = stock_symbols[index];
                                    const processedResults = result.results
                                        .filter(item => {
                                            if (exaUrlSet.has(item.url)) return false;
                                            exaUrlSet.add(item.url);
                                            return true;
                                        })
                                        .map(item => ({
                                            title: item.title || "",
                                            url: item.url,
                                            content: item.summary || "",
                                            published_date: item.publishedDate,
                                            category: "financial",
                                            query: stockSymbol
                                        }));

                                    if (processedResults.length > 0) {
                                        exaResults.push({
                                            query: stockSymbol,
                                            topic: "financial",
                                            results: processedResults
                                        });
                                    }
                                });

                                // Complete missing titles for financial reports
                                for (const group of exaResults) {
                                    for (let i = 0; i < group.results.length; i++) {
                                        const result = group.results[i];
                                        if (!result.title || result.title.trim() === "") {
                                            try {
                                                const { object } = await generateObject({
                                                    model: openai.chat("gpt-4.1-nano"),
                                                    prompt: `Complete the following financial report with an appropriate title. The report is about ${group.query} and contains this content: ${result.content.substring(0, 500)}...`,
                                                    schema: z.object({
                                                        title: z.string().describe("A descriptive title for the financial report")
                                                    }),
                                                });
                                                group.results[i].title = object.title;
                                            } catch (error) {
                                                console.error(`Error generating title for ${group.query} report:`, error);
                                                group.results[i].title = `${group.query} Financial Report`;
                                            }
                                        }
                                    }
                                }

                                // Merge Exa results with news results
                                news_results = [...news_results, ...exaResults];
                            } catch (error) {
                                console.error("Error fetching Exa financial reports:", error);
                            }

                            const code = `
import yfinance as yf
import matplotlib.pyplot as plt
import pandas as pd
from datetime import datetime

${stock_symbols.map(symbol =>
                                `${symbol.toLowerCase().replace('.', '')} = yf.download('${symbol}', period='${interval}', interval='1d')`).join('\n')}

# Create the plot
plt.figure(figsize=(10, 6))
${stock_symbols.map(symbol => `
# Convert datetime64 index to strings to make it serializable
${symbol.toLowerCase().replace('.', '')}.index = ${symbol.toLowerCase().replace('.', '')}.index.strftime('%Y-%m-%d')
plt.plot(${symbol.toLowerCase().replace('.', '')}.index, ${symbol.toLowerCase().replace('.', '')}['Close'], label='${symbol} ${formattedCurrencySymbols[stock_symbols.indexOf(symbol)]}', color='blue')
`).join('\n')}

# Customize the chart
plt.title('${title}')
plt.xlabel('Date')
plt.ylabel('Closing Price')
plt.legend()
plt.grid(True)
plt.show()`

                            console.log('Code:', code);

                            const daytona = new Daytona()
                            const sandbox = await daytona.create({
                                language: 'python',
                                target: SandboxTargetRegion.US,
                                resources: {
                                    cpu: 2,
                                    memory: 5,
                                    disk: 10,
                                },
                                autoStopInterval: 0
                            })

                            const pipInstall = await sandbox.process.executeCommand('pip install yfinance');
                            console.log('Pip install:', pipInstall.result);
                            
                            const execution = await sandbox.process.codeRun(code);
                            let message = '';

                            if (execution.result) {
                                message += execution.result;
                            }

                    
                            if (execution.artifacts?.stdout) {
                                message += execution.artifacts.stdout;
                            }

                            console.log("execution exit code: ", execution.exitCode)
                            console.log("execution result: ", execution.result)

                            console.log("Chart details: ", execution.artifacts?.charts)
                            if (execution.artifacts?.charts) {
                                console.log("showing chart")
                                execution.artifacts.charts[0].elements.map((element: any) => {
                                    console.log(element.points);
                                });
                            }

                            if (execution.artifacts?.charts === undefined) {
                                console.log("No chart found");
                            }

                            await sandbox.delete();

                            // map the chart to the correct format for the frontend and remove the png property
                            const chart = execution.artifacts?.charts?.[0] ?? undefined;
                            const chartData = chart ? {
                                type: chart.type,
                                title: chart.title,
                                elements: chart.elements,
                                png: undefined
                            } : undefined;

                            return {
                                message: message.trim(),
                                chart: chartData,
                                currency_symbols: formattedCurrencySymbols,
                                news_results: news_results
                            };
                        },
                    }),
                    currency_converter: tool({
                        description: 'Convert currency from one to another using yfinance',
                        parameters: z.object({
                            from: z.string().describe('The source currency code.'),
                            to: z.string().describe('The target currency code.'),
                            amount: z.number().describe('The amount to convert. Default is 1.'),
                        }),
                        execute: async ({ from, to, amount }: { from: string; to: string; amount: number }) => {
                            const code = `
  import yfinance as yf
  from_currency = '${from}'
  to_currency = '${to}'
  currency_pair = f'{from_currency}{to_currency}=X'
  data = yf.Ticker(currency_pair).history(period='1d')
  latest_rate = data['Close'].iloc[-1]
  latest_rate = latest_rate * ${amount}
  `;
                            console.log('Currency pair:', from, to);

                            const sandbox = await CodeInterpreter.create(serverEnv.SANDBOX_TEMPLATE_ID!);
                            const execution = await sandbox.runCode(code);
                            let message = '';

                            if (execution.results.length > 0) {
                                for (const result of execution.results) {
                                    if (result.isMainResult) {
                                        message += `${result.text}\n`;
                                    } else {
                                        message += `${result.text}\n`;
                                    }
                                }
                            }

                            if (execution.logs.stdout.length > 0 || execution.logs.stderr.length > 0) {
                                if (execution.logs.stdout.length > 0) {
                                    message += `${execution.logs.stdout.join('\n')}\n`;
                                }
                                if (execution.logs.stderr.length > 0) {
                                    message += `${execution.logs.stderr.join('\n')}\n`;
                                }
                            }

                            if (execution.error) {
                                message += `Error: ${execution.error}\n`;
                                console.log('Error: ', execution.error);
                            }

                            return { rate: message.trim() };
                        },
                    }),
                    text_translate: tool({
                        description: "Translate text from one language to another.",
                        parameters: z.object({
                            text: z.string().describe("The text to translate."),
                            to: z.string().describe("The language to translate to (e.g., 'fr' for French)."),
                        }),
                        execute: async ({ text, to }: { text: string; to: string }) => {
                            const { object: translation } = await generateObject({
                                model: scira.languageModel(model),
                                system: `You are a helpful assistant that translates text from one language to another.`,
                                prompt: `Translate the following text to ${to} language: ${text}`,
                                schema: z.object({
                                    translatedText: z.string(),
                                    detectedLanguage: z.string(),
                                }),
                            });
                            console.log(translation);
                            return {
                                translatedText: translation.translatedText,
                                detectedLanguage: translation.detectedLanguage,
                            };
                        },
                    }),
                    web_search: tool({
                        description: 'Search the web for information with 5-10 queries, max results and search depth.',
                        parameters: z.object({
                            queries: z.array(z.string().describe('Array of search queries to look up on the web. Default is 5 to 10 queries.')),
                            maxResults: z.array(
                                z.number().describe('Array of maximum number of results to return per query. Default is 10.'),
                            ),
                            topics: z.array(
                                z.enum(['general', 'news', 'finance']).describe('Array of topic types to search for. Default is general.'),
                            ),
                            searchDepth: z.array(
                                z.enum(['basic', 'advanced']).describe('Array of search depths to use. Default is basic. Use advanced for more detailed results.'),
                            ),
                            include_domains: z
                                .array(z.string())
                                .describe('A list of domains to include in all search results. Default is an empty list.'),
                            exclude_domains: z
                                .array(z.string())
                                .describe('A list of domains to exclude from all search results. Default is an empty list.'),
                        }),
                        execute: async ({
                            queries,
                            maxResults,
                            topics,
                            searchDepth,
                            include_domains,
                            exclude_domains,
                        }: {
                            queries: string[];
                            maxResults: number[];
                            topics: ('general' | 'news' | 'finance')[];
                            searchDepth: ('basic' | 'advanced')[];
                            include_domains?: string[];
                            exclude_domains?: string[];
                        }) => {
                            const apiKey = serverEnv.TAVILY_API_KEY;
                            const tvly = tavily({ apiKey });
                            const includeImageDescriptions = true;

                            console.log('Queries:', queries);
                            console.log('Max Results:', maxResults);
                            console.log('Topics:', topics);
                            console.log('Search Depths:', searchDepth);
                            console.log('Include Domains:', include_domains);
                            console.log('Exclude Domains:', exclude_domains);

                            // Execute searches in parallel
                            const searchPromises = queries.map(async (query, index) => {
                                const data = await tvly.search(query, {
                                    topic: topics[index] || topics[0] || 'general',
                                    days: topics[index] === 'news' ? 7 : undefined,
                                    maxResults: maxResults[index] || maxResults[0] || 10,
                                    searchDepth: searchDepth[index] || searchDepth[0] || 'basic',
                                    includeAnswer: true,
                                    includeImages: true,
                                    includeImageDescriptions: includeImageDescriptions,
                                    excludeDomains: exclude_domains || undefined,
                                    includeDomains: include_domains || undefined,
                                });

                                // Add annotation for query completion
                                dataStream.writeMessageAnnotation({
                                    type: 'query_completion',
                                    data: {
                                        query,
                                        index,
                                        total: queries.length,
                                        status: 'completed',
                                        resultsCount: data.results.length,
                                        imagesCount: data.images.length
                                    }
                                });

                                return {
                                    query,
                                    results: deduplicateByDomainAndUrl(data.results).map((obj: any) => ({
                                        url: obj.url,
                                        title: obj.title,
                                        content: obj.content,
                                        published_date: topics[index] === 'news' ? obj.published_date : undefined,
                                    })),
                                    images: includeImageDescriptions
                                        ? await Promise.all(
                                            deduplicateByDomainAndUrl(data.images).map(
                                                async ({ url, description }: { url: string; description?: string }) => {
                                                    const sanitizedUrl = sanitizeUrl(url);
                                                    const imageValidation = await isValidImageUrl(sanitizedUrl);
                                                    return imageValidation.valid
                                                        ? {
                                                            url: imageValidation.redirectedUrl || sanitizedUrl,
                                                            description: description ?? '',
                                                        }
                                                        : null;
                                                },
                                            ),
                                        ).then((results) =>
                                            results.filter(
                                                (image): image is { url: string; description: string } =>
                                                    image !== null &&
                                                    typeof image === 'object' &&
                                                    typeof image.description === 'string' &&
                                                    image.description !== '',
                                            ),
                                        )
                                        : await Promise.all(
                                            deduplicateByDomainAndUrl(data.images).map(async ({ url }: { url: string }) => {
                                                const sanitizedUrl = sanitizeUrl(url);
                                                const imageValidation = await isValidImageUrl(sanitizedUrl);
                                                return imageValidation.valid ? (imageValidation.redirectedUrl || sanitizedUrl) : null;
                                            }),
                                        ).then((results) => results.filter((url) => url !== null) as string[]),
                                };
                            });

                            const searchResults = await Promise.all(searchPromises);

                            return {
                                searches: searchResults,
                            };
                        },
                    }),
                    movie_or_tv_search: tool({
                        description: 'Search for a movie or TV show using TMDB API',
                        parameters: z.object({
                            query: z.string().describe('The search query for movies/TV shows'),
                        }),
                        execute: async ({ query }: { query: string }) => {
                            const TMDB_API_KEY = serverEnv.TMDB_API_KEY;
                            const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

                            try {
                                // First do a multi-search to get the top result
                                const searchResponse = await fetch(
                                    `${TMDB_BASE_URL}/search/multi?query=${encodeURIComponent(
                                        query,
                                    )}&language=en-US&page=1`,
                                    {
                                        headers: {
                                            Authorization: `Bearer ${TMDB_API_KEY}`,
                                            accept: 'application/json',
                                        },
                                    },
                                );

                                // catch error if the response is not ok
                                if (!searchResponse.ok) {
                                    console.error('TMDB search error:', searchResponse.statusText);
                                    return { result: null };
                                }

                                const searchResults = await searchResponse.json();

                                // Get the first movie or TV show result
                                const firstResult = searchResults.results.find(
                                    (result: any) => result.media_type === 'movie' || result.media_type === 'tv',
                                );

                                if (!firstResult) {
                                    return { result: null };
                                }

                                // Get detailed information for the media
                                const detailsResponse = await fetch(
                                    `${TMDB_BASE_URL}/${firstResult.media_type}/${firstResult.id}?language=en-US`,
                                    {
                                        headers: {
                                            Authorization: `Bearer ${TMDB_API_KEY}`,
                                            accept: 'application/json',
                                        },
                                    },
                                );

                                const details = await detailsResponse.json();

                                // Get additional credits information
                                const creditsResponse = await fetch(
                                    `${TMDB_BASE_URL}/${firstResult.media_type}/${firstResult.id}/credits?language=en-US`,
                                    {
                                        headers: {
                                            Authorization: `Bearer ${TMDB_API_KEY}`,
                                            accept: 'application/json',
                                        },
                                    },
                                );

                                const credits = await creditsResponse.json();

                                // Format the result
                                const result = {
                                    ...details,
                                    media_type: firstResult.media_type,
                                    credits: {
                                        cast:
                                            credits.cast?.slice(0, 8).map((person: any) => ({
                                                ...person,
                                                profile_path: person.profile_path
                                                    ? `https://image.tmdb.org/t/p/original${person.profile_path}`
                                                    : null,
                                            })) || [],
                                        director: credits.crew?.find((person: any) => person.job === 'Director')?.name,
                                        writer: credits.crew?.find(
                                            (person: any) => person.job === 'Screenplay' || person.job === 'Writer',
                                        )?.name,
                                    },
                                    poster_path: details.poster_path
                                        ? `https://image.tmdb.org/t/p/original${details.poster_path}`
                                        : null,
                                    backdrop_path: details.backdrop_path
                                        ? `https://image.tmdb.org/t/p/original${details.backdrop_path}`
                                        : null,
                                };

                                return { result };
                            } catch (error) {
                                console.error('TMDB search error:', error);
                                throw error;
                            }
                        },
                    }),
                    trending_movies: tool({
                        description: 'Get trending movies from TMDB',
                        parameters: z.object({}),
                        execute: async () => {
                            const TMDB_API_KEY = serverEnv.TMDB_API_KEY;
                            const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

                            try {
                                const response = await fetch(`${TMDB_BASE_URL}/trending/movie/day?language=en-US`, {
                                    headers: {
                                        Authorization: `Bearer ${TMDB_API_KEY}`,
                                        accept: 'application/json',
                                    },
                                });

                                const data = await response.json();
                                const results = data.results.map((movie: any) => ({
                                    ...movie,
                                    poster_path: movie.poster_path
                                        ? `https://image.tmdb.org/t/p/original${movie.poster_path}`
                                        : null,
                                    backdrop_path: movie.backdrop_path
                                        ? `https://image.tmdb.org/t/p/original${movie.backdrop_path}`
                                        : null,
                                }));

                                return { results };
                            } catch (error) {
                                console.error('Trending movies error:', error);
                                throw error;
                            }
                        },
                    }),
                    trending_tv: tool({
                        description: 'Get trending TV shows from TMDB',
                        parameters: z.object({}),
                        execute: async () => {
                            const TMDB_API_KEY = serverEnv.TMDB_API_KEY;
                            const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

                            try {
                                const response = await fetch(`${TMDB_BASE_URL}/trending/tv/day?language=en-US`, {
                                    headers: {
                                        Authorization: `Bearer ${TMDB_API_KEY}`,
                                        accept: 'application/json',
                                    },
                                });

                                const data = await response.json();
                                const results = data.results.map((show: any) => ({
                                    ...show,
                                    poster_path: show.poster_path
                                        ? `https://image.tmdb.org/t/p/original${show.poster_path}`
                                        : null,
                                    backdrop_path: show.backdrop_path
                                        ? `https://image.tmdb.org/t/p/original${show.backdrop_path}`
                                        : null,
                                }));

                                return { results };
                            } catch (error) {
                                console.error('Trending TV shows error:', error);
                                throw error;
                            }
                        },
                    }),
                    academic_search: tool({
                        description: 'Search academic papers and research.',
                        parameters: z.object({
                            query: z.string().describe('The search query'),
                        }),
                        execute: async ({ query }: { query: string }) => {
                            try {
                                const exa = new Exa(serverEnv.EXA_API_KEY as string);

                                // Search academic papers with content summary
                                const result = await exa.searchAndContents(query, {
                                    type: 'auto',
                                    numResults: 20,
                                    category: 'research paper',
                                    summary: {
                                        query: 'Abstract of the Paper',
                                    },
                                });

                                // Process and clean results
                                const processedResults = result.results.reduce<typeof result.results>((acc, paper) => {
                                    // Skip if URL already exists or if no summary available
                                    if (acc.some((p) => p.url === paper.url) || !paper.summary) return acc;

                                    // Clean up summary (remove "Summary:" prefix if exists)
                                    const cleanSummary = paper.summary.replace(/^Summary:\s*/i, '');

                                    // Clean up title (remove [...] suffixes)
                                    const cleanTitle = paper.title?.replace(/\s\[.*?\]$/, '');

                                    acc.push({
                                        ...paper,
                                        title: cleanTitle || '',
                                        summary: cleanSummary,
                                    });

                                    return acc;
                                }, []);

                                return {
                                    results: processedResults,
                                };
                            } catch (error) {
                                console.error('Academic search error:', error);
                                throw error;
                            }
                        },
                    }),
                    youtube_search: tool({
                        description: 'Search YouTube videos using Exa AI and get detailed video information.',
                        parameters: z.object({
                            query: z.string().describe('The search query for YouTube videos'),
                        }),
                        execute: async ({ query, }: { query: string; }) => {
                            try {
                                const exa = new Exa(serverEnv.EXA_API_KEY as string);

                                // Simple search to get YouTube URLs only
                                const searchResult = await exa.search(query, {
                                    type: 'keyword',
                                    numResults: 10,
                                    includeDomains: ['youtube.com'],
                                });

                                // Process results
                                const processedResults = await Promise.all(
                                    searchResult.results.map(async (result): Promise<VideoResult | null> => {
                                        const videoIdMatch = result.url.match(
                                            /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&?/]+)/,
                                        );
                                        const videoId = videoIdMatch?.[1];

                                        if (!videoId) return null;

                                        // Base result
                                        const baseResult: VideoResult = {
                                            videoId,
                                            url: result.url,
                                        };

                                        try {
                                            // Fetch detailed info from our endpoints
                                            const [detailsResponse, captionsResponse, timestampsResponse] = await Promise.all([
                                                fetch(`${serverEnv.YT_ENDPOINT}/video-data`, {
                                                    method: 'POST',
                                                    headers: {
                                                        'Content-Type': 'application/json',
                                                    },
                                                    body: JSON.stringify({
                                                        url: result.url,
                                                    }),
                                                }).then((res) => (res.ok ? res.json() : null)),
                                                fetch(`${serverEnv.YT_ENDPOINT}/video-captions`, {
                                                    method: 'POST',
                                                    headers: {
                                                        'Content-Type': 'application/json',
                                                    },
                                                    body: JSON.stringify({
                                                        url: result.url,
                                                    }),
                                                }).then((res) => (res.ok ? res.text() : null)),
                                                fetch(`${serverEnv.YT_ENDPOINT}/video-timestamps`, {
                                                    method: 'POST',
                                                    headers: {
                                                        'Content-Type': 'application/json',
                                                    },
                                                    body: JSON.stringify({
                                                        url: result.url,
                                                    }),
                                                }).then((res) => (res.ok ? res.json() : null)),
                                            ]);

                                            // Return combined data
                                            return {
                                                ...baseResult,
                                                details: detailsResponse || undefined,
                                                captions: captionsResponse || undefined,
                                                timestamps: timestampsResponse || undefined,
                                            };
                                        } catch (error) {
                                            console.error(`Error fetching details for video ${videoId}:`, error);
                                            return baseResult;
                                        }
                                    }),
                                );

                                // Filter out null results
                                const validResults = processedResults.filter(
                                    (result): result is VideoResult => result !== null,
                                );

                                return {
                                    results: validResults,
                                };
                            } catch (error) {
                                console.error('YouTube search error:', error);
                                throw error;
                            }
                        },
                    }),
                    retrieve: tool({
                        description: 'Retrieve the full content from a URL using Exa AI, including text, title, summary, images, and more.',
                        parameters: z.object({
                            url: z.string().describe('The URL to retrieve the information from.'),
                            include_summary: z.boolean().describe('Whether to include a summary of the content. Default is true.'),
                            live_crawl: z.enum(['never', 'auto', 'always']).describe('Whether to crawl the page immediately. Options: never, auto, always. Default is "always".'),
                        }),
                        execute: async ({
                            url,
                            include_summary = true,
                            live_crawl = 'always'
                        }: {
                            url: string;
                            include_summary?: boolean;
                            live_crawl?: 'never' | 'auto' | 'always';
                        }) => {
                        try {
                                const exa = new Exa(serverEnv.EXA_API_KEY as string);
                                
                                console.log(`Retrieving content from ${url} with Exa AI, summary: ${include_summary}, livecrawl: ${live_crawl}`);
                                
                                const start = Date.now();
                                
                                const result = await exa.getContents(
                                    [url],
                                    {
                                        text: true,
                                        summary: include_summary ? true : undefined,
                                        livecrawl: live_crawl
                                    }
                                );
                                
                                // Check if there are results
                                if (!result.results || result.results.length === 0) {
                                    console.error('Exa AI error: No content retrieved');
                                    return { error: 'Failed to retrieve content', results: [] };
                                }
                                
                                return {
                                    base_url: url,
                                    results: result.results.map((item) => {
                                        // Type assertion to access potentially missing properties
                                        const typedItem = item as any;
                                        return {
                                            url: item.url,
                                            content: typedItem.text || typedItem.summary || '',
                                            title: typedItem.title || item.url.split('/').pop() || 'Retrieved Content',
                                            description: typedItem.summary || `Content retrieved from ${item.url}`,
                                            author: typedItem.author || undefined,
                                            publishedDate: typedItem.publishedDate || undefined,
                                            image: typedItem.image || undefined,
                                            favicon: typedItem.favicon || undefined,
                                            language: 'en',
                                        };
                                    }),
                                    response_time: (Date.now() - start) / 1000
                                };
                            } catch (error) {
                                console.error('Exa AI error:', error);
                                return { error: error instanceof Error ? error.message : 'Failed to retrieve content', results: [] };
                            }
                        },
                    }),
                    get_weather_data: tool({
                        description: 'Get the weather data for the given location name using geocoding and OpenWeather API.',
                        parameters: z.object({
                            location: z.string().describe('The name of the location to get weather data for (e.g., "London", "New York", "Tokyo").')
                        }),
                        execute: async ({ location }: { location: string }) => {
                            try {
                                // Step 1: Geocode the location name using Open Meteo API
                                const geocodingResponse = await fetch(
                                    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`
                                );
                                
                                const geocodingData = await geocodingResponse.json();
                                
                                if (!geocodingData.results || geocodingData.results.length === 0) {
                                    throw new Error(`Location '${location}' not found`);
                                }
                                
                                const { latitude, longitude, name, country, timezone } = geocodingData.results[0];
                                console.log('Latitude:', latitude);
                                console.log('Longitude:', longitude);
                                // Step 2: Fetch weather data using OpenWeather API with the obtained coordinates
                                const apiKey = serverEnv.OPENWEATHER_API_KEY;
                                const [weatherResponse, airPollutionResponse, dailyForecastResponse] = await Promise.all([
                                    fetch(
                                        `https://api.openweathermap.org/data/2.5/forecast?lat=${latitude}&lon=${longitude}&appid=${apiKey}`
                                    ),
                                    fetch(
                                        `https://api.openweathermap.org/data/2.5/air_pollution?lat=${latitude}&lon=${longitude}&appid=${apiKey}`
                                    ),
                                    fetch(
                                        `https://api.openweathermap.org/data/2.5/forecast/daily?lat=${latitude}&lon=${longitude}&cnt=16&appid=${apiKey}`
                                    )
                                ]);
                                
                                const [weatherData, airPollutionData, dailyForecastData] = await Promise.all([
                                    weatherResponse.json(),
                                    airPollutionResponse.json(),
                                    dailyForecastResponse.json().catch(error => {
                                        console.error('Daily forecast API error:', error);
                                        return { list: [] }; // Return empty data if API fails
                                    })
                                ]);
                                
                                // Step 3: Fetch air pollution forecast
                                const airPollutionForecastResponse = await fetch(
                                    `https://api.openweathermap.org/data/2.5/air_pollution/forecast?lat=${latitude}&lon=${longitude}&appid=${apiKey}`
                                );
                                const airPollutionForecastData = await airPollutionForecastResponse.json();
                                
                                // Add geocoding information to the weather data
                                return {
                                    ...weatherData,
                                    geocoding: {
                                        latitude,
                                        longitude,
                                        name,
                                        country,
                                        timezone
                                    },
                                    air_pollution: airPollutionData,
                                    air_pollution_forecast: airPollutionForecastData,
                                    daily_forecast: dailyForecastData
                                };
                            } catch (error) {
                                console.error('Weather data error:', error);
                                throw error;
                            }
                        },
                    }),
                    code_interpreter: tool({
                        description: 'Write and execute Python code.',
                        parameters: z.object({
                            title: z.string().describe('The title of the code snippet.'),
                            code: z
                                .string()
                                .describe(
                                    'The Python code to execute. put the variables in the end of the code to print them. do not use the print function.',
                                ),
                            icon: z
                                .enum(['stock', 'date', 'calculation', 'default'])
                                .describe('The icon to display for the code snippet.'),
                        }),
                        execute: async ({ code, title, icon }: { code: string; title: string; icon: string }) => {
                            console.log('Code:', code);
                            console.log('Title:', title);
                            console.log('Icon:', icon);

                            const daytona = new Daytona()
                            const sandbox = await daytona.create({
                                language: 'python',
                                target: SandboxTargetRegion.US,
                                resources: {
                                    cpu: 4,
                                    memory: 8,
                                    disk: 10,
                                },
                                timeout: 300,
                            })

                            const execution = await sandbox.process.codeRun(code);

                            console.log('Execution:', execution.result);
                            console.log('Execution:', execution.artifacts?.stdout);

                            let message = '';                            

                            if (execution.result) {
                                message += execution.result;
                            }

                            if (execution.artifacts?.stdout) {
                                message += execution.artifacts.stdout;
                            }
                            
                            if (execution.artifacts?.charts) {
                               console.log('Chart:', execution.artifacts.charts[0]);
                            }

                            let chart;

                            if (execution.artifacts?.charts) {
                                chart = execution.artifacts.charts[0];
                            }

                            // map the chart to the correct format for the frontend and remove the png property
                            const chartData = chart ? {
                                type: chart.type,
                                title: chart.title,
                                elements: chart.elements,
                                png: undefined
                            } : undefined;

                            await sandbox.delete();

                            return {
                                message: message.trim(),
                                chart: chartData,
                            };
                        },
                    }),
                    find_place: tool({
                        description:
                            'Find a place using Google Maps API for forward geocoding and Mapbox for reverse geocoding.',
                        parameters: z.object({
                            query: z.string().describe('The search query for forward geocoding'),
                            coordinates: z.array(z.number()).describe('Array of [latitude, longitude] for reverse geocoding'),
                        }),
                        execute: async ({ query, coordinates }: { query: string; coordinates: number[] }) => {
                            try {
                                // Forward geocoding with Google Maps API
                                const googleApiKey = serverEnv.GOOGLE_MAPS_API_KEY;
                                const googleResponse = await fetch(
                                    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
                                        query,
                                    )}&key=${googleApiKey}`,
                                );
                                const googleData = await googleResponse.json();

                                // Reverse geocoding with Mapbox
                                const mapboxToken = serverEnv.MAPBOX_ACCESS_TOKEN;
                                const [lat, lng] = coordinates;
                                const mapboxResponse = await fetch(
                                    `https://api.mapbox.com/search/geocode/v6/reverse?longitude=${lng}&latitude=${lat}&access_token=${mapboxToken}`,
                                );
                                const mapboxData = await mapboxResponse.json();

                                // Process and combine results
                                const features = [];

                                // Process Google results
                                if (googleData.status === 'OK' && googleData.results.length > 0) {
                                    features.push(
                                        ...googleData.results.map((result: GoogleResult) => ({
                                            id: result.place_id,
                                            name: result.formatted_address.split(',')[0],
                                            formatted_address: result.formatted_address,
                                            geometry: {
                                                type: 'Point',
                                                coordinates: [result.geometry.location.lng, result.geometry.location.lat],
                                            },
                                            feature_type: result.types[0],
                                            address_components: result.address_components,
                                            viewport: result.geometry.viewport,
                                            place_id: result.place_id,
                                            source: 'google',
                                        })),
                                    );
                                }

                                // Process Mapbox results
                                if (mapboxData.features && mapboxData.features.length > 0) {
                                    features.push(
                                        ...mapboxData.features.map(
                                            (feature: any): MapboxFeature => ({
                                                id: feature.id,
                                                name: feature.properties.name_preferred || feature.properties.name,
                                                formatted_address: feature.properties.full_address,
                                                geometry: feature.geometry,
                                                feature_type: feature.properties.feature_type,
                                                context: feature.properties.context,
                                                coordinates: feature.properties.coordinates,
                                                bbox: feature.properties.bbox,
                                                source: 'mapbox',
                                            }),
                                        ),
                                    );
                                }

                                return {
                                    features,
                                    google_attribution: 'Powered by Google Maps Platform',
                                    mapbox_attribution: 'Powered by Mapbox',
                                };
                            } catch (error) {
                                console.error('Geocoding error:', error);
                                throw error;
                            }
                        },
                    }),
                    text_search: tool({
                        description: 'Perform a text-based search for places using Mapbox API.',
                        parameters: z.object({
                            query: z.string().describe("The search query (e.g., '123 main street')."),
                            location: z.string().describe("The location to center the search (e.g., '42.3675294,-71.186966')."),
                            radius: z.number().describe('The radius of the search area in meters (max 50000).'),
                        }),
                        execute: async ({ query, location, radius }: { query: string; location?: string; radius?: number }) => {
                            const mapboxToken = serverEnv.MAPBOX_ACCESS_TOKEN;

                            let proximity = '';
                            if (location) {
                                const [lng, lat] = location.split(',').map(Number);
                                proximity = `&proximity=${lng},${lat}`;
                            }

                            const response = await fetch(
                                `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
                                    query,
                                )}.json?types=poi${proximity}&access_token=${mapboxToken}`,
                            );
                            const data = await response.json();

                            // If location and radius provided, filter results by distance
                            let results = data.features;
                            if (location && radius) {
                                const [centerLng, centerLat] = location.split(',').map(Number);
                                const radiusInDegrees = radius / 111320;
                                results = results.filter((feature: any) => {
                                    const [placeLng, placeLat] = feature.center;
                                    const distance = Math.sqrt(
                                        Math.pow(placeLng - centerLng, 2) + Math.pow(placeLat - centerLat, 2),
                                    );
                                    return distance <= radiusInDegrees;
                                });
                            }

                            return {
                                results: results.map((feature: any) => ({
                                    name: feature.text,
                                    formatted_address: feature.place_name,
                                    geometry: {
                                        location: {
                                            lat: feature.center[1],
                                            lng: feature.center[0],
                                        },
                                    },
                                })),
                            };
                        },
                    }),
                    nearby_search: tool({
                        description: 'Search for nearby places, such as restaurants or hotels based on the details given.',
                        parameters: z.object({
                            location: z.string().describe('The location name given by user.'),
                            latitude: z.number().describe('The latitude of the location.'),
                            longitude: z.number().describe('The longitude of the location.'),
                            type: z
                                .string()
                                .describe('The type of place to search for (restaurants, hotels, attractions, geos).'),
                            radius: z.number().describe('The radius in meters (max 50000).'),
                        }),
                        execute: async ({
                            location,
                            latitude,
                            longitude,
                            type,
                            radius,
                        }: {
                            latitude: number;
                            longitude: number;
                            location: string;
                            type: string;
                            radius: number;
                        }) => {
                            const apiKey = serverEnv.TRIPADVISOR_API_KEY;
                            let finalLat = latitude;
                            let finalLng = longitude;

                            try {
                                // Try geocoding first
                                const geocodingData = await fetch(
                                    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
                                        location,
                                    )}&key=${serverEnv.GOOGLE_MAPS_API_KEY}`,
                                );

                                const geocoding = await geocodingData.json();

                                if (geocoding.results?.[0]?.geometry?.location) {
                                    let trimmedLat = geocoding.results[0].geometry.location.lat.toString().split('.');
                                    finalLat = parseFloat(trimmedLat[0] + '.' + trimmedLat[1].slice(0, 6));
                                    let trimmedLng = geocoding.results[0].geometry.location.lng.toString().split('.');
                                    finalLng = parseFloat(trimmedLng[0] + '.' + trimmedLng[1].slice(0, 6));
                                    console.log('Using geocoded coordinates:', finalLat, finalLng);
                                } else {
                                    console.log('Using provided coordinates:', finalLat, finalLng);
                                }

                                // Get nearby places
                                const nearbyResponse = await fetch(
                                    `https://api.content.tripadvisor.com/api/v1/location/nearby_search?latLong=${finalLat},${finalLng}&category=${type}&radius=${radius}&language=en&key=${apiKey}`,
                                    {
                                        method: 'GET',
                                        headers: {
                                            Accept: 'application/json',
                                            origin: 'https://mplx.local',
                                            referer: 'https://mplx.local',
                                        },
                                    },
                                );

                                if (!nearbyResponse.ok) {
                                    throw new Error(`Nearby search failed: ${nearbyResponse.status}`);
                                }

                                const nearbyData = await nearbyResponse.json();

                                if (!nearbyData.data || nearbyData.data.length === 0) {
                                    console.log('No nearby places found');
                                    return {
                                        results: [],
                                        center: { lat: finalLat, lng: finalLng },
                                    };
                                }

                                // Process each place
                                const detailedPlaces = await Promise.all(
                                    nearbyData.data.map(async (place: any) => {
                                        try {
                                            if (!place.location_id) {
                                                console.log(`Skipping place "${place.name}": No location_id`);
                                                return null;
                                            }

                                            // Fetch place details
                                            const detailsResponse = await fetch(
                                                `https://api.content.tripadvisor.com/api/v1/location/${place.location_id}/details?language=en&currency=USD&key=${apiKey}`,
                                                {
                                                    method: 'GET',
                                                    headers: {
                                                        Accept: 'application/json',
                                                        origin: 'https://mplx.local',
                                                        referer: 'https://mplx.local',
                                                    },
                                                },
                                            );

                                            if (!detailsResponse.ok) {
                                                console.log(`Failed to fetch details for "${place.name}"`);
                                                return null;
                                            }

                                            const details = await detailsResponse.json();

                                            console.log(`Place details for "${place.name}":`, details);

                                            // Fetch place photos
                                            let photos = [];
                                            try {
                                                const photosResponse = await fetch(
                                                    `https://api.content.tripadvisor.com/api/v1/location/${place.location_id}/photos?language=en&key=${apiKey}`,
                                                    {
                                                        method: 'GET',
                                                        headers: {
                                                            Accept: 'application/json',
                                                            origin: 'https://mplx.local',
                                                            referer: 'https://mplx.local',
                                                        },
                                                    },
                                                );

                                                if (photosResponse.ok) {
                                                    const photosData = await photosResponse.json();
                                                    photos =
                                                        photosData.data
                                                            ?.map((photo: any) => ({
                                                                thumbnail: photo.images?.thumbnail?.url,
                                                                small: photo.images?.small?.url,
                                                                medium: photo.images?.medium?.url,
                                                                large: photo.images?.large?.url,
                                                                original: photo.images?.original?.url,
                                                                caption: photo.caption,
                                                            }))
                                                            .filter((photo: any) => photo.medium) || [];
                                                }
                                            } catch (error) {
                                                console.log(`Photo fetch failed for "${place.name}":`, error);
                                            }

                                            // Get timezone for the location
                                            const tzResponse = await fetch(
                                                `https://maps.googleapis.com/maps/api/timezone/json?location=${details.latitude
                                                },${details.longitude}&timestamp=${Math.floor(Date.now() / 1000)}&key=${serverEnv.GOOGLE_MAPS_API_KEY
                                                }`,
                                            );
                                            const tzData = await tzResponse.json();
                                            const timezone = tzData.timeZoneId || 'UTC';

                                            // Process hours and status with timezone
                                            const localTime = new Date(
                                                new Date().toLocaleString('en-US', {
                                                    timeZone: timezone,
                                                }),
                                            );
                                            const currentDay = localTime.getDay();
                                            const currentHour = localTime.getHours();
                                            const currentMinute = localTime.getMinutes();
                                            const currentTime = currentHour * 100 + currentMinute;

                                            let is_closed = true;
                                            let next_open_close = null;
                                            let next_day = currentDay;

                                            if (details.hours?.periods) {
                                                // Sort periods by day and time for proper handling of overnight hours
                                                const sortedPeriods = [...details.hours.periods].sort((a, b) => {
                                                    if (a.open.day !== b.open.day) return a.open.day - b.open.day;
                                                    return parseInt(a.open.time) - parseInt(b.open.time);
                                                });

                                                // Find current or next opening period
                                                for (let i = 0; i < sortedPeriods.length; i++) {
                                                    const period = sortedPeriods[i];
                                                    const openTime = parseInt(period.open.time);
                                                    const closeTime = period.close ? parseInt(period.close.time) : 2359;
                                                    const periodDay = period.open.day;

                                                    // Handle overnight hours
                                                    if (closeTime < openTime) {
                                                        // Place is open from previous day
                                                        if (currentDay === periodDay && currentTime < closeTime) {
                                                            is_closed = false;
                                                            next_open_close = period.close.time;
                                                            break;
                                                        }
                                                        // Place is open today and extends to tomorrow
                                                        if (currentDay === periodDay && currentTime >= openTime) {
                                                            is_closed = false;
                                                            next_open_close = period.close.time;
                                                            next_day = (periodDay + 1) % 7;
                                                            break;
                                                        }
                                                    } else {
                                                        // Normal hours within same day
                                                        if (
                                                            currentDay === periodDay &&
                                                            currentTime >= openTime &&
                                                            currentTime < closeTime
                                                        ) {
                                                            is_closed = false;
                                                            next_open_close = period.close.time;
                                                            break;
                                                        }
                                                    }

                                                    // Find next opening time if currently closed
                                                    if (is_closed) {
                                                        if (
                                                            periodDay > currentDay ||
                                                            (periodDay === currentDay && openTime > currentTime)
                                                        ) {
                                                            next_open_close = period.open.time;
                                                            next_day = periodDay;
                                                            break;
                                                        }
                                                    }
                                                }
                                            }

                                            // Return processed place data
                                            return {
                                                name: place.name || 'Unnamed Place',
                                                location: {
                                                    lat: parseFloat(details.latitude || place.latitude || finalLat),
                                                    lng: parseFloat(details.longitude || place.longitude || finalLng),
                                                },
                                                timezone,
                                                place_id: place.location_id,
                                                vicinity: place.address_obj?.address_string || '',
                                                distance: parseFloat(place.distance || '0'),
                                                bearing: place.bearing || '',
                                                type: type,
                                                rating: parseFloat(details.rating || '0'),
                                                price_level: details.price_level || '',
                                                cuisine: details.cuisine?.[0]?.name || '',
                                                description: details.description || '',
                                                phone: details.phone || '',
                                                website: details.website || '',
                                                reviews_count: parseInt(details.num_reviews || '0'),
                                                is_closed,
                                                hours: details.hours?.weekday_text || [],
                                                next_open_close,
                                                next_day,
                                                periods: details.hours?.periods || [],
                                                photos,
                                                source: details.source?.name || 'TripAdvisor',
                                            };
                                        } catch (error) {
                                            console.log(`Failed to process place "${place.name}":`, error);
                                            return null;
                                        }
                                    }),
                                );

                                // Filter and sort results
                                const validPlaces = detailedPlaces
                                    .filter((place) => place !== null)
                                    .sort((a, b) => (a?.distance || 0) - (b?.distance || 0));

                                return {
                                    results: validPlaces,
                                    center: { lat: finalLat, lng: finalLng },
                                };
                            } catch (error) {
                                console.error('Nearby search error:', error);
                                throw error;
                            }
                        },
                    }),
                    track_flight: tool({
                        description: 'Track flight information and status',
                        parameters: z.object({
                            flight_number: z.string().describe('The flight number to track'),
                        }),
                        execute: async ({ flight_number }: { flight_number: string }) => {
                            try {
                                const response = await fetch(
                                    `https://api.aviationstack.com/v1/flights?access_key=${serverEnv.AVIATION_STACK_API_KEY}&flight_iata=${flight_number}`,
                                );
                                return await response.json();
                            } catch (error) {
                                console.error('Flight tracking error:', error);
                                throw error;
                            }
                        },
                    }),
                    datetime: tool({
                        description: 'Get the current date and time in the user\'s timezone',
                        parameters: z.object({}),
                        execute: async () => {
                            try {
                                const now = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));

                                // Format date and time using the timezone
                                return {
                                    timestamp: now.getTime(),
                                    iso: now.toISOString(),
                                    timezone: timezone,
                                    formatted: {
                                        date: new Intl.DateTimeFormat('en-US', {
                                            weekday: 'long',
                                            year: 'numeric',
                                            month: 'long',
                                            day: 'numeric',
                                            timeZone: timezone
                                        }).format(now),
                                        time: new Intl.DateTimeFormat('en-US', {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                            second: '2-digit',
                                            hour12: true,
                                            timeZone: timezone
                                        }).format(now),
                                        dateShort: new Intl.DateTimeFormat('en-US', {
                                            month: 'short',
                                            day: 'numeric',
                                            year: 'numeric',
                                            timeZone: timezone
                                        }).format(now),
                                        timeShort: new Intl.DateTimeFormat('en-US', {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                            hour12: true,
                                            timeZone: timezone
                                        }).format(now)
                                    }
                                };
                            } catch (error) {
                                console.error('Datetime error:', error);
                                throw error;
                            }
                        },
                    }),
                    mcp_search: tool({
                        description: 'Search for mcp servers and get the information about them',
                        parameters: z.object({
                            query: z.string().describe('The query to search for'),
                        }),
                        execute: async ({ query }: { query: string }) => {
                            try {
                                // Call the Smithery Registry API
                                const response = await fetch(
                                    `https://registry.smithery.ai/servers?q=${encodeURIComponent(query)}`,
                                    {
                                        headers: {
                                            'Authorization': `Bearer ${serverEnv.SMITHERY_API_KEY}`,
                                            'Content-Type': 'application/json',
                                        },
                                    }
                                );

                                if (!response.ok) {
                                    throw new Error(`Smithery API error: ${response.status} ${response.statusText}`);
                                }

                                const data = await response.json();

                                // Get detailed information for each server
                                const detailedServers = await Promise.all(
                                    data.servers.map(async (server: any) => {
                                        const detailResponse = await fetch(
                                            `https://registry.smithery.ai/servers/${encodeURIComponent(server.qualifiedName)}`,
                                            {
                                                headers: {
                                                    'Authorization': `Bearer ${serverEnv.SMITHERY_API_KEY}`,
                                                    'Content-Type': 'application/json',
                                                },
                                            }
                                        );

                                        if (!detailResponse.ok) {
                                            console.warn(`Failed to fetch details for ${server.qualifiedName}`);
                                            return server;
                                        }

                                        const details = await detailResponse.json();
                                        return {
                                            ...server,
                                            deploymentUrl: details.deploymentUrl,
                                            connections: details.connections,
                                        };
                                    })
                                );

                                return {
                                    servers: detailedServers,
                                    pagination: data.pagination,
                                    query: query
                                };
                            } catch (error) {
                                console.error('Smithery search error:', error);
                                return {
                                    error: error instanceof Error ? error.message : 'Unknown error',
                                    query: query
                                };
                            }
                        },
                    }),
                    reason_search: tool({
                        description: 'Perform a reasoned web search with multiple steps and sources.',
                        parameters: z.object({
                            topic: z.string().describe('The main topic or question to research'),
                            depth: z.enum(['basic', 'advanced']).describe('Search depth level'),
                        }),
                        execute: async ({ topic, depth }: { topic: string; depth: 'basic' | 'advanced' }) => {
                            const apiKey = serverEnv.TAVILY_API_KEY;
                            const tvly = tavily({ apiKey });
                            const exa = new Exa(serverEnv.EXA_API_KEY as string);

                            // Send initial plan status update (without steps count and extra details)
                            dataStream.writeMessageAnnotation({
                                type: 'research_update',
                                data: {
                                    id: 'research-plan-initial', // unique id for the initial state
                                    type: 'plan',
                                    status: 'running',
                                    title: 'Research Plan',
                                    message: 'Creating research plan...',
                                    timestamp: Date.now(),
                                    overwrite: true
                                }
                            });

                            // Now generate the research plan
                            const { object: researchPlan } = await generateObject({
                                model: xai("grok-3-mini-fast"),
                                temperature: 0,
                                schema: z.object({
                                    search_queries: z.array(z.object({
                                        query: z.string(),
                                        rationale: z.string(),
                                        source: z.enum(['web', 'academic', 'x', 'all']),
                                        priority: z.number().min(1).max(5)
                                    })).max(12),
                                    required_analyses: z.array(z.object({
                                        type: z.string(),
                                        description: z.string(),
                                        importance: z.number().min(1).max(5)
                                    })).max(8)
                                }),
                                prompt: `Create a focused research plan for the topic: "${topic}". 
                                        
                                        Today's date and day of the week: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                                
                                        Keep the plan concise but comprehensive, with:
                                        - 4-12 targeted search queries (each can use web, academic, x (Twitter), or all sources)
                                        - 2-8 key analyses to perform
                                        - Prioritize the most important aspects to investigate
                                        
                                        Available sources:
                                        - "web": General web search
                                        - "academic": Academic papers and research
                                        - "x": X/Twitter posts and discussions
                                        - "all": Use all source types (web, academic, and X/Twitter)
                                        
                                        Do not use floating numbers, use whole numbers only in the priority field!!
                                        Do not keep the numbers too low or high, make them reasonable in between.
                                        Do not use 0 or 1 in the priority field, use numbers between 2 and 4.
                                        
                                        Consider different angles and potential controversies, but maintain focus on the core aspects.
                                        Ensure the total number of steps (searches + analyses) does not exceed 20.`
                            });

                            // Generate IDs for all steps based on the plan
                            const generateStepIds = (plan: typeof researchPlan) => {
                                // Generate an array of search steps.
                                const searchSteps = plan.search_queries.flatMap((query, index) => {
                                    if (query.source === 'all') {
                                        return [
                                            { id: `search-web-${index}`, type: 'web', query },
                                            { id: `search-academic-${index}`, type: 'academic', query },
                                            { id: `search-x-${index}`, type: 'x', query }
                                        ];
                                    }
                                    if (query.source === 'x') {
                                        return [{ id: `search-x-${index}`, type: 'x', query }];
                                    }
                                    const searchType = query.source === 'academic' ? 'academic' : 'web';
                                    return [{ id: `search-${searchType}-${index}`, type: searchType, query }];
                                });

                                // Generate an array of analysis steps.
                                const analysisSteps = plan.required_analyses.map((analysis, index) => ({
                                    id: `analysis-${index}`,
                                    type: 'analysis',
                                    analysis
                                }));

                                return {
                                    planId: 'research-plan',
                                    searchSteps,
                                    analysisSteps
                                };
                            };

                            const stepIds = generateStepIds(researchPlan);
                            let completedSteps = 0;
                            const totalSteps = stepIds.searchSteps.length + stepIds.analysisSteps.length;

                            // Complete plan status
                            dataStream.writeMessageAnnotation({
                                type: 'research_update',
                                data: {
                                    id: stepIds.planId,
                                    type: 'plan',
                                    status: 'completed',
                                    title: 'Research Plan',
                                    plan: researchPlan,
                                    totalSteps: totalSteps,
                                    message: 'Research plan created',
                                    timestamp: Date.now(),
                                    overwrite: true
                                }
                            });

                            // Execute searches
                            const searchResults = [];
                            let searchIndex = 0;  // Add index tracker

                            for (const step of stepIds.searchSteps) {
                                // Send running annotation for this search step
                                dataStream.writeMessageAnnotation({
                                    type: 'research_update',
                                    data: {
                                        id: step.id,
                                        type: step.type,
                                        status: 'running',
                                        title: step.type === 'web'
                                            ? `Searching the web for "${step.query.query}"`
                                            : step.type === 'academic'
                                                ? `Searching academic papers for "${step.query.query}"`
                                                : step.type === 'x'
                                                    ? `Searching X/Twitter for "${step.query.query}"`
                                                    : `Analyzing ${step.query.query}`,
                                        query: step.query.query,
                                        message: `Searching ${step.query.source} sources...`,
                                        timestamp: Date.now()
                                    }
                                });

                                if (step.type === 'web') {
                                    const webResults = await tvly.search(step.query.query, {
                                        searchDepth: depth,
                                        includeAnswer: true,
                                        maxResults: Math.min(6 - step.query.priority, 10)
                                    });

                                    searchResults.push({
                                        type: 'web',
                                        query: step.query,
                                        results: webResults.results.map(r => ({
                                            source: 'web',
                                            title: r.title,
                                            url: r.url,
                                            content: r.content
                                        }))
                                    });
                                    completedSteps++;
                                } else if (step.type === 'academic') {
                                    const academicResults = await exa.searchAndContents(step.query.query, {
                                        type: 'auto',
                                        numResults: Math.min(6 - step.query.priority, 5),
                                        category: 'research paper',
                                        summary: true
                                    });

                                    searchResults.push({
                                        type: 'academic',
                                        query: step.query,
                                        results: academicResults.results.map(r => ({
                                            source: 'academic',
                                            title: r.title || '',
                                            url: r.url || '',
                                            content: r.summary || ''
                                        }))
                                    });
                                    completedSteps++;
                                } else if (step.type === 'x') {
                                    // Extract tweet ID from URL
                                    const extractTweetId = (url: string): string | null => {
                                        const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
                                        return match ? match[1] : null;
                                    };

                                    const xResults = await exa.searchAndContents(step.query.query, {
                                        type: 'neural',
                                        useAutoprompt: true,
                                        numResults: step.query.priority,
                                        text: true,
                                        highlights: true,
                                        includeDomains: ['twitter.com', 'x.com']
                                    });

                                    // Process tweets to include tweet IDs
                                    const processedTweets = xResults.results.map(result => {
                                        const tweetId = extractTweetId(result.url);
                                        return {
                                            source: 'x' as const,
                                            title: result.title || result.author || 'Tweet',
                                            url: result.url,
                                            content: result.text || '',
                                            tweetId: tweetId || undefined
                                        };
                                    }).filter(tweet => tweet.tweetId); // Only include tweets with valid IDs

                                    searchResults.push({
                                        type: 'x',
                                        query: step.query,
                                        results: processedTweets
                                    });
                                    completedSteps++;
                                }

                                // Send completed annotation for the search step
                                dataStream.writeMessageAnnotation({
                                    type: 'research_update',
                                    data: {
                                        id: step.id,
                                        type: step.type,
                                        status: 'completed',
                                        title: step.type === 'web'
                                            ? `Searched the web for "${step.query.query}"`
                                            : step.type === 'academic'
                                                ? `Searched academic papers for "${step.query.query}"`
                                                : step.type === 'x'
                                                    ? `Searched X/Twitter for "${step.query.query}"`
                                                    : `Analysis of ${step.query.query} complete`,
                                        query: step.query.query,
                                        results: searchResults[searchResults.length - 1].results.map(r => {
                                            return { ...r };
                                        }),
                                        message: `Found ${searchResults[searchResults.length - 1].results.length} results`,
                                        timestamp: Date.now(),
                                        overwrite: true
                                    }
                                });

                                searchIndex++;  // Increment index
                            }

                            // Perform analyses
                            let analysisIndex = 0;  // Add index tracker

                            for (const step of stepIds.analysisSteps) {
                                dataStream.writeMessageAnnotation({
                                    type: 'research_update',
                                    data: {
                                        id: step.id,
                                        type: 'analysis',
                                        status: 'running',
                                        title: `Analyzing ${step.analysis.type}`,
                                        analysisType: step.analysis.type,
                                        message: `Analyzing ${step.analysis.type}...`,
                                        timestamp: Date.now()
                                    }
                                });

                                const { object: analysisResult } = await generateObject({
                                    model: xai("grok-3-mini-fast"),
                                    temperature: 0.5,
                                    schema: z.object({
                                        findings: z.array(z.object({
                                            insight: z.string(),
                                            evidence: z.array(z.string()),
                                            confidence: z.number().min(0).max(1)
                                        })),
                                        implications: z.array(z.string()),
                                        limitations: z.array(z.string())
                                    }),
                                    prompt: `Perform a ${step.analysis.type} analysis on the search results. ${step.analysis.description}
                                            Consider all sources and their reliability.
                                            Search results: ${JSON.stringify(searchResults)}`
                                });

                                dataStream.writeMessageAnnotation({
                                    type: 'research_update',
                                    data: {
                                        id: step.id,
                                        type: 'analysis',
                                        status: 'completed',
                                        title: `Analysis of ${step.analysis.type} complete`,
                                        analysisType: step.analysis.type,
                                        findings: analysisResult.findings,
                                        message: `Analysis complete`,
                                        timestamp: Date.now(),
                                        overwrite: true
                                    }
                                });

                                analysisIndex++;  // Increment index
                            }

                            // After all analyses are complete, send running state for gap analysis
                            dataStream.writeMessageAnnotation({
                                type: 'research_update',
                                data: {
                                    id: 'gap-analysis',
                                    type: 'analysis',
                                    status: 'running',
                                    title: 'Research Gaps and Limitations',
                                    analysisType: 'gaps',
                                    message: 'Analyzing research gaps and limitations...',
                                    timestamp: Date.now()
                                }
                            });

                            // After all analyses are complete, analyze limitations and gaps
                            const { object: gapAnalysis } = await generateObject({
                                model: xai("grok-3-mini-fast"),
                                temperature: 0,
                                schema: z.object({
                                    limitations: z.array(z.object({
                                        type: z.string(),
                                        description: z.string(),
                                        severity: z.number().min(2).max(10),
                                        potential_solutions: z.array(z.string())
                                    })),
                                    knowledge_gaps: z.array(z.object({
                                        topic: z.string(),
                                        reason: z.string(),
                                        additional_queries: z.array(z.string())
                                    })),
                                    recommended_followup: z.array(z.object({
                                        action: z.string(),
                                        rationale: z.string(),
                                        priority: z.number().min(2).max(10)
                                    }))
                                }),
                                prompt: `Analyze the research results and identify limitations, knowledge gaps, and recommended follow-up actions.
                                        Consider:
                                        - Quality and reliability of sources
                                        - Missing perspectives or data
                                        - Areas needing deeper investigation
                                        - Potential biases or conflicts
                                        - Severity should be between 2 and 10
                                        - Knowledge gaps should be between 2 and 10
                                        - Do not keep the numbers too low or high, make them reasonable in between
                                        
                                        When suggesting additional_queries for knowledge gaps, keep in mind these will be used to search:
                                        - Web sources
                                        - Academic papers
                                        - X/Twitter for social media perspectives and real-time information
                                        
                                        Design your additional_queries to work well across these different source types.
                                        
                                        Research results: ${JSON.stringify(searchResults)}
                                        Analysis findings: ${JSON.stringify(stepIds.analysisSteps.map(step => ({
                                    type: step.analysis.type,
                                    description: step.analysis.description,
                                    importance: step.analysis.importance
                                })))}`
                            });

                            // Send gap analysis update
                            dataStream.writeMessageAnnotation({
                                type: 'research_update',
                                data: {
                                    id: 'gap-analysis',
                                    type: 'analysis',
                                    status: 'completed',
                                    title: 'Research Gaps and Limitations',
                                    analysisType: 'gaps',
                                    findings: gapAnalysis.limitations.map(l => ({
                                        insight: l.description,
                                        evidence: l.potential_solutions,
                                        confidence: (6 - l.severity) / 5
                                    })),
                                    gaps: gapAnalysis.knowledge_gaps,
                                    recommendations: gapAnalysis.recommended_followup,
                                    message: `Identified ${gapAnalysis.limitations.length} limitations and ${gapAnalysis.knowledge_gaps.length} knowledge gaps`,
                                    timestamp: Date.now(),
                                    overwrite: true,
                                    completedSteps: completedSteps + 1,
                                    totalSteps: totalSteps + (depth === 'advanced' ? 2 : 1)
                                }
                            });

                            let synthesis;

                            // If there are significant gaps and depth is 'advanced', perform additional research
                            if (depth === 'advanced' && gapAnalysis.knowledge_gaps.length > 0) {
                                // For important gaps, create 'all' source queries to be comprehensive
                                const additionalQueries = gapAnalysis.knowledge_gaps.flatMap(gap =>
                                    gap.additional_queries.map((query, idx) => {
                                        // For critical gaps, use 'all' sources for the first query
                                        // Distribute others across different source types for efficiency
                                        const sourceTypes = ['web', 'academic', 'x', 'all'] as const;
                                        let source: 'web' | 'academic' | 'x' | 'all';

                                        // Use 'all' for the first query of each gap, then rotate through specific sources
                                        if (idx === 0) {
                                            source = 'all';
                                        } else {
                                            source = sourceTypes[idx % (sourceTypes.length - 1)] as 'web' | 'academic' | 'x';
                                        }

                                        return {
                                            query,
                                            rationale: gap.reason,
                                            source,
                                            priority: 3
                                        };
                                    })
                                );

                                // Execute additional searches for gaps
                                for (const query of additionalQueries) {
                                    // Generate a unique ID for this gap search
                                    const gapSearchId = `gap-search-${searchIndex++}`;

                                    // Execute search based on source type
                                    if (query.source === 'web' || query.source === 'all') {
                                        // Execute web search
                                        const webResults = await tvly.search(query.query, {
                                            searchDepth: depth,
                                            includeAnswer: true,
                                            maxResults: 5
                                        });

                                        // Add to search results
                                        searchResults.push({
                                            type: 'web',
                                            query: {
                                                query: query.query,
                                                rationale: query.rationale,
                                                source: 'web',
                                                priority: query.priority
                                            },
                                            results: webResults.results.map(r => ({
                                                source: 'web',
                                                title: r.title,
                                                url: r.url,
                                                content: r.content
                                            }))
                                        });

                                        // Send completed annotation for web search
                                        dataStream.writeMessageAnnotation({
                                            type: 'research_update',
                                            data: {
                                                id: query.source === 'all' ? `gap-search-web-${searchIndex - 3}` : gapSearchId,
                                                type: 'web',
                                                status: 'completed',
                                                title: `Additional web search for "${query.query}"`,
                                                query: query.query,
                                                results: webResults.results.map(r => ({
                                                    source: 'web',
                                                    title: r.title,
                                                    url: r.url,
                                                    content: r.content
                                                })),
                                                message: `Found ${webResults.results.length} results`,
                                                timestamp: Date.now(),
                                                overwrite: true
                                            }
                                        });
                                    }

                                    if (query.source === 'academic' || query.source === 'all') {
                                        const academicSearchId = query.source === 'all' ? `gap-search-academic-${searchIndex++}` : gapSearchId;

                                        // Send running annotation for academic search if it's for 'all' source
                                        if (query.source === 'all') {
                                            dataStream.writeMessageAnnotation({
                                                type: 'research_update',
                                                data: {
                                                    id: academicSearchId,
                                                    type: 'academic',
                                                    status: 'running',
                                                    title: `Additional academic search for "${query.query}"`,
                                                    query: query.query,
                                                    message: `Searching academic sources to fill knowledge gap: ${query.rationale}`,
                                                    timestamp: Date.now()
                                                }
                                            });
                                        }

                                        // Execute academic search
                                        const academicResults = await exa.searchAndContents(query.query, {
                                            type: 'auto',
                                            numResults: 3,
                                            category: 'research paper',
                                            summary: true
                                        });

                                        // Add to search results
                                        searchResults.push({
                                            type: 'academic',
                                            query: {
                                                query: query.query,
                                                rationale: query.rationale,
                                                source: 'academic',
                                                priority: query.priority
                                            },
                                            results: academicResults.results.map(r => ({
                                                source: 'academic',
                                                title: r.title || '',
                                                url: r.url || '',
                                                content: r.summary || ''
                                            }))
                                        });

                                        // Send completed annotation for academic search
                                        dataStream.writeMessageAnnotation({
                                            type: 'research_update',
                                            data: {
                                                id: academicSearchId,
                                                type: 'academic',
                                                status: 'completed',
                                                title: `Additional academic search for "${query.query}"`,
                                                query: query.query,
                                                results: academicResults.results.map(r => ({
                                                    source: 'academic',
                                                    title: r.title || '',
                                                    url: r.url || '',
                                                    content: r.summary || ''
                                                })),
                                                message: `Found ${academicResults.results.length} results`,
                                                timestamp: Date.now(),
                                                overwrite: query.source === 'all' ? true : false
                                            }
                                        });
                                    }

                                    if (query.source === 'x' || query.source === 'all') {
                                        const xSearchId = query.source === 'all' ? `gap-search-x-${searchIndex++}` : gapSearchId;

                                        // Send running annotation for X search if it's for 'all' source
                                        if (query.source === 'all') {
                                            dataStream.writeMessageAnnotation({
                                                type: 'research_update',
                                                data: {
                                                    id: xSearchId,
                                                    type: 'x',
                                                    status: 'running',
                                                    title: `Additional X/Twitter search for "${query.query}"`,
                                                    query: query.query,
                                                    message: `Searching X/Twitter to fill knowledge gap: ${query.rationale}`,
                                                    timestamp: Date.now()
                                                }
                                            });
                                        }

                                        // Extract tweet ID from URL
                                        const extractTweetId = (url: string): string | null => {
                                            const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
                                            return match ? match[1] : null;
                                        };

                                        // Execute X/Twitter search
                                        const xResults = await exa.searchAndContents(query.query, {
                                            type: 'keyword',
                                            numResults: 5,
                                            text: true,
                                            highlights: true,
                                            includeDomains: ['twitter.com', 'x.com']
                                        });

                                        // Process tweets to include tweet IDs - properly handling undefined
                                        const processedTweets = xResults.results
                                            .map(result => {
                                                const tweetId = extractTweetId(result.url);
                                                if (!tweetId) return null; // Skip entries without valid tweet IDs

                                                return {
                                                    source: 'x' as const,
                                                    title: result.title || result.author || 'Tweet',
                                                    url: result.url,
                                                    content: result.text || '',
                                                    tweetId // Now it's definitely string, not undefined
                                                };
                                            })
                                            .filter((tweet): tweet is { source: 'x', title: string, url: string, content: string, tweetId: string } =>
                                                tweet !== null
                                            );

                                        // Add to search results
                                        searchResults.push({
                                            type: 'x',
                                            query: {
                                                query: query.query,
                                                rationale: query.rationale,
                                                source: 'x',
                                                priority: query.priority
                                            },
                                            results: processedTweets
                                        });

                                        // Send completed annotation for X search
                                        dataStream.writeMessageAnnotation({
                                            type: 'research_update',
                                            data: {
                                                id: xSearchId,
                                                type: 'x',
                                                status: 'completed',
                                                title: `Additional X/Twitter search for "${query.query}"`,
                                                query: query.query,
                                                results: processedTweets,
                                                message: `Found ${processedTweets.length} results`,
                                                timestamp: Date.now(),
                                                overwrite: query.source === 'all' ? true : false
                                            }
                                        });
                                    }
                                }

                                // Send running state for final synthesis
                                dataStream.writeMessageAnnotation({
                                    type: 'research_update',
                                    data: {
                                        id: 'final-synthesis',
                                        type: 'analysis',
                                        status: 'running',
                                        title: 'Final Research Synthesis',
                                        analysisType: 'synthesis',
                                        message: 'Synthesizing all research findings...',
                                        timestamp: Date.now()
                                    }
                                });

                                // Perform final synthesis of all findings
                                const { object: finalSynthesis } = await generateObject({
                                    model: xai("grok-3-mini-fast"),
                                    temperature: 0,
                                    schema: z.object({
                                        key_findings: z.array(z.object({
                                            finding: z.string(),
                                            confidence: z.number().min(0).max(1),
                                            supporting_evidence: z.array(z.string())
                                        })),
                                        remaining_uncertainties: z.array(z.string())
                                    }),
                                    prompt: `Synthesize all research findings, including gap analysis and follow-up research.
                                            Highlight key conclusions and remaining uncertainties.
                                            Stick to the types of the schema, do not add any other fields or types.
                                            
                                            Original results: ${JSON.stringify(searchResults)}
                                            Gap analysis: ${JSON.stringify(gapAnalysis)}
                                            Additional findings: ${JSON.stringify(additionalQueries)}`
                                });

                                synthesis = finalSynthesis;

                                // Send final synthesis update
                                dataStream.writeMessageAnnotation({
                                    type: 'research_update',
                                    data: {
                                        id: 'final-synthesis',
                                        type: 'analysis',
                                        status: 'completed',
                                        title: 'Final Research Synthesis',
                                        analysisType: 'synthesis',
                                        findings: finalSynthesis.key_findings.map(f => ({
                                            insight: f.finding,
                                            evidence: f.supporting_evidence,
                                            confidence: f.confidence
                                        })),
                                        uncertainties: finalSynthesis.remaining_uncertainties,
                                        message: `Synthesized ${finalSynthesis.key_findings.length} key findings`,
                                        timestamp: Date.now(),
                                        overwrite: true,
                                        completedSteps: totalSteps + (depth === 'advanced' ? 2 : 1) - 1,
                                        totalSteps: totalSteps + (depth === 'advanced' ? 2 : 1)
                                    }
                                });
                            }

                            // Final progress update
                            const finalProgress = {
                                id: 'research-progress',
                                type: 'progress' as const,
                                status: 'completed' as const,
                                message: `Research complete`,
                                completedSteps: totalSteps + (depth === 'advanced' ? 2 : 1),
                                totalSteps: totalSteps + (depth === 'advanced' ? 2 : 1),
                                isComplete: true,
                                timestamp: Date.now()
                            };

                            dataStream.writeMessageAnnotation({
                                type: 'research_update',
                                data: {
                                    ...finalProgress,
                                    overwrite: true
                                }
                            });

                            return {
                                plan: researchPlan,
                                results: searchResults,
                                synthesis: synthesis
                            };
                        },
                    }),
                    memory_manager: tool({
                        description: 'Manage personal memories with add and search operations.',
                        parameters: z.object({
                            action: z.enum(['add', 'search']).describe('The memory operation to perform'),
                            content: z.string().describe('The memory content for add operation'),
                            query: z.string().describe('The search query for search operations'),
                        }),
                        execute: async ({ action, content, query }: {
                            action: 'add' | 'search';
                            content?: string;
                            query?: string;
                        }) => {
                            const client = new MemoryClient({ apiKey: serverEnv.MEM0_API_KEY });

                            console.log("action", action);
                            console.log("content", content);
                            console.log("query", query);

                            try {
                                switch (action) {
                                    case 'add': {
                                        if (!content) {
                                            return {
                                                success: false,
                                                action: 'add',
                                                message: 'Content is required for add operation'
                                            };
                                        }
                                        const result = await client.add(content, {
                                            user_id,
                                            org_id: serverEnv.MEM0_ORG_ID,
                                            project_id: serverEnv.MEM0_PROJECT_ID
                                        });
                                        if (result.length === 0) {
                                            return {
                                                success: false,
                                                action: 'add',
                                                message: 'No memory added'
                                            };
                                        }
                                        console.log("result", result);
                                        return {
                                            success: true,
                                            action: 'add',
                                            memory: result[0]
                                        };
                                    }
                                    case 'search': {
                                        if (!query) {
                                            return {
                                                success: false,
                                                action: 'search',
                                                message: 'Query is required for search operation'
                                            };
                                        }
                                        const searchFilters = {
                                            AND: [
                                                { user_id },
                                            ]
                                        };
                                        const result = await client.search(query, {
                                            filters: searchFilters,
                                            api_version: 'v2'
                                        });
                                        if (!result || !result[0]) {
                                            return {
                                                success: false,
                                                action: 'search',
                                                message: 'No results found for the search query'
                                            };
                                        }
                                        return {
                                            success: true,
                                            action: 'search',
                                            results: result[0]
                                        };
                                    }
                                }
                            } catch (error) {
                                console.error('Memory operation error:', error);
                                throw error;
                            }
                        },
                    }),
                    reddit_search: tool({
                        description: 'Search Reddit content using Tavily API.',
                        parameters: z.object({
                            query: z.string().describe('The exact search query from the user.'),
                            maxResults: z.number().describe('Maximum number of results to return. Default is 20.'),
                            timeRange: z.enum(['day', 'week', 'month', 'year']).describe('Time range for Reddit search.'),
                        }),
                        execute: async ({
                            query, 
                            maxResults = 20, 
                            timeRange = 'week',
                        }: { 
                            query: string; 
                            maxResults?: number;
                            timeRange?: 'day' | 'week' | 'month' | 'year';
                        }) => {
                            const apiKey = serverEnv.TAVILY_API_KEY;
                            const tvly = tavily({ apiKey });
                            
                            console.log('Reddit search query:', query);
                            console.log('Max results:', maxResults);
                            console.log('Time range:', timeRange);
                            
                            try {
                                const data = await tvly.search(query, {
                                    maxResults: maxResults,
                                    timeRange: timeRange,
                                    includeRawContent: true,
                                    searchDepth: 'basic',
                                    topic: 'general',
                                    includeDomains: ["reddit.com"],
                                });

                                console.log("data", data);
                                
                                // Process results for better display
                                const processedResults = data.results.map(result => {
                                    // Extract Reddit post metadata
                                    const isRedditPost = result.url.includes('/comments/');
                                    const subreddit = isRedditPost ? 
                                        result.url.match(/reddit\.com\/r\/([^/]+)/)?.[1] || 'unknown' : 
                                        'unknown';
                                    
                                    // Don't attempt to parse comments - treat content as a single snippet
                                    // The Tavily API already returns short content snippets
                                    return {
                                        url: result.url,
                                        title: result.title,
                                        content: result.content || '',
                                        score: result.score,
                                        published_date: result.publishedDate,
                                        subreddit,
                                        isRedditPost,
                                        // Keep original content as a single comment/snippet
                                        comments: result.content ? [result.content] : []
                                    };
                                });
                                
                                return {
                                    query,
                                    results: processedResults,
                                    timeRange,
                                };
                            } catch (error) {
                                console.error('Reddit search error:', error);
                                throw error;
                            }
                        },
                    }),
                },
                experimental_repairToolCall: async ({
                    toolCall,
                    tools,
                    parameterSchema,
                    error,
                }) => {
                    if (NoSuchToolError.isInstance(error)) {
                        return null; // do not attempt to fix invalid tool names
                    }

                    console.log("Fixing tool call================================");
                    console.log("toolCall", toolCall);
                    console.log("tools", tools);
                    console.log("parameterSchema", parameterSchema);
                    console.log("error", error);

                    const tool = tools[toolCall.toolName as keyof typeof tools];

                    const { object: repairedArgs } = await generateObject({
                        model: scira.languageModel("scira-default"),
                        schema: tool.parameters,
                        prompt: [
                            `The model tried to call the tool "${toolCall.toolName}"` +
                            ` with the following arguments:`,
                            JSON.stringify(toolCall.args),
                            `The tool accepts the following schema:`,
                            JSON.stringify(parameterSchema(toolCall)),
                            'Please fix the arguments.',
                            'Do not use print statements stock chart tool.',
                            `For the stock chart tool you have to generate a python code with matplotlib and yfinance to plot the stock chart.`,
                            `For the web search make multiple queries to get the best results.`,
                            `Today's date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`
                        ].join('\n'),
                    });

                    console.log("repairedArgs", repairedArgs);

                    return { ...toolCall, args: JSON.stringify(repairedArgs) };
                },
                onChunk(event) {
                    if (event.chunk.type === 'tool-call') {
                        console.log('Called Tool: ', event.chunk.toolName);
                    }
                },
                onStepFinish(event) {
                    if (event.warnings) {
                        console.log('Warnings: ', event.warnings);
                    }
                },
                onFinish(event) {
                    console.log('Fin reason: ', event.finishReason);
                    console.log('Reasoning: ', event.reasoning);
                    console.log('reasoning details: ', event.reasoningDetails);
                    console.log('Steps: ', event.steps);
                    console.log('Messages: ', event.response.messages);
                    console.log('Response: ', event.response);
                },
                onError(event) {
                    console.log('Error: ', event.error);
                },
            });

            result.mergeIntoDataStream(dataStream, {
                sendReasoning: true
            });
        }
    })

}