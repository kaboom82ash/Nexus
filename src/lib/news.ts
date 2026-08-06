/**
 * RSS news fetching for the News widget.
 *
 * A static browser page can't fetch most RSS feeds directly (the publishers
 * send no CORS headers), so we go through a CORS-enabled RSS→JSON converter
 * (rss2json). The feed URL is configurable; it defaults to CNN Top Stories.
 */

const RSS2JSON = 'https://api.rss2json.com/v1/api.json'

export const CNN_TOP_STORIES = 'http://rss.cnn.com/rss/cnn_topstories.rss'

export interface NewsItem {
  title: string
  link: string
  /** ISO-ish date string from the feed (may be empty). */
  date: string
}

export interface NewsResult {
  items: NewsItem[]
  source: string
}

interface Rss2JsonResponse {
  status: string
  message?: string
  feed?: { title?: string }
  items?: { title?: string; link?: string; pubDate?: string }[]
}

export async function fetchNews(
  feedUrl: string,
  limit: number,
  signal?: AbortSignal,
): Promise<NewsResult> {
  const count = Math.min(50, Math.max(1, limit))
  const url = `${RSS2JSON}?rss_url=${encodeURIComponent(feedUrl)}&count=${count}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Feed error (${res.status})`)
  const data = (await res.json()) as Rss2JsonResponse
  if (data.status !== 'ok') {
    throw new Error(data.message || 'Feed unavailable')
  }
  const items: NewsItem[] = (data.items ?? [])
    .slice(0, limit)
    .map((it) => ({
      title: it.title ?? '(untitled)',
      link: it.link ?? '',
      date: it.pubDate ?? '',
    }))
  return { items, source: data.feed?.title || 'News' }
}
