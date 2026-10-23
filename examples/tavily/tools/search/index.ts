export default async function search(args: {
  query: string;
  limit?: number;
  topic?: string;
  days?: number;
}) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: args.query,
      max_results: args.limit ?? 8,
      topic: args.topic ?? "general",
      days: args.days,
    }),
  });
  if (!response.ok) throw new Error(`Tavily: HTTP ${response.status}`);
  const { results } = (await response.json()) as {
    results: { title?: string; url: string; content?: string }[];
  };
  return results.map(({ title, url, content }) => ({ title, url, content }));
}
