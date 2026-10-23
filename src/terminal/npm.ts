export async function searchPackages(query: string) {
  const url = new URL("https://registry.npmjs.org/-/v1/search");
  url.searchParams.set("text", `keywords:nu-package ${query}`.trim());
  url.searchParams.set("size", "20");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`npm search: HTTP ${response.status}`);
  const { objects } = (await response.json()) as {
    objects: {
      package: { name: string; version: string; description?: string };
    }[];
  };
  return objects.map(({ package: pkg }) => ({
    source: `npm:${pkg.name}`,
    version: pkg.version,
    description: pkg.description ?? "",
  }));
}
