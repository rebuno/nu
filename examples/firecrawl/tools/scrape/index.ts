const MAX_TEXT = 50_000;

export default async function scrape(args: { url: string }) {
  const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url: args.url,
      formats: ["markdown"],
      onlyMainContent: true,
    }),
  });
  if (!response.ok) throw new Error(`Firecrawl: HTTP ${response.status}`);
  const { data } = (await response.json()) as {
    data: { markdown?: string; metadata?: { title?: string } };
  };
  return {
    title: data.metadata?.title,
    markdown: (data.markdown ?? "").slice(0, MAX_TEXT),
  };
}
