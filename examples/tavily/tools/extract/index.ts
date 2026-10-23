const MAX_TEXT = 50_000;

export default async function extract(args: { urls: string[] }) {
  const response = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ urls: args.urls, format: "markdown" }),
  });
  if (!response.ok) throw new Error(`Tavily: HTTP ${response.status}`);
  const { results, failed_results } = (await response.json()) as {
    results: { url: string; raw_content?: string }[];
    failed_results?: { url: string; error?: string }[];
  };
  const budget = Math.floor(MAX_TEXT / Math.max(results.length, 1));
  return {
    pages: results.map(({ url, raw_content }) => ({
      url,
      markdown: (raw_content ?? "").slice(0, budget),
    })),
    failed: failed_results ?? [],
  };
}
