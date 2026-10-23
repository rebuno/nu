# nu-firecrawl

Web search and page reading for [Nu](https://github.com/rebuno/nu) through
[Firecrawl](https://www.firecrawl.dev).

Get an API key from Firecrawl, then install the package and give Nu the key:

```bash
nu install ./examples/firecrawl
printf %s '<API key>' | nu secret set FIRECRAWL_API_KEY
```

| Tool | Does |
|---|---|
| `firecrawl__search` | Searches the web and returns titles, URLs, and snippets |
| `firecrawl__scrape` | Reads a page and returns its main content as markdown |

The suggested rules let Nu search and read pages without asking.
