const express = require('express')
const { chromium } = require('playwright')

const app = express()
const PORT = 3000
const CACHE_TTL = 10 * 60 * 1000 // 10 minutes

// Cache store { url: { data, timestamp } }
const cache = {}

// Allow all CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', '*')
  res.header('Access-Control-Allow-Methods', '*')
  next()
})

let browser;

async function launchBrowser() {
  browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  })
  console.log('Browser launched!')
}

function getCached(url) {
  const entry = cache[url]
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    delete cache[url]
    return null
  }
  return entry.data
}

function setCache(url, data) {
  cache[url] = { data, timestamp: Date.now() }
}

// GET /info?url=https://anything.com
app.get('/info', async (req, res) => {
  const url = req.query.url
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' })
  try { new URL(url) } catch { return res.status(400).json({ error: 'Invalid URL' }) }

  // Check cache
  const cached = getCached(url)
  if (cached) return res.json({ ...cached, cached: true })

  let page;
  try {
    page = await browser.newPage()
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })

    const data = await page.evaluate(() => {
      const getMeta = (name) =>
        document.querySelector(`meta[name="${name}"]`)?.content ||
        document.querySelector(`meta[property="${name}"]`)?.content || null

      // All meta tags
      const meta = {}
      document.querySelectorAll('meta').forEach(m => {
        const key = m.getAttribute('name') || m.getAttribute('property')
        const val = m.getAttribute('content')
        if (key && val) meta[key] = val
      })

      // All images
      const images = [...document.querySelectorAll('img')]
        .map(img => ({ src: img.src, alt: img.alt, width: img.width, height: img.height }))
        .filter(img => img.src)

      // All videos
      const videos = [...document.querySelectorAll('video, video source')]
        .map(v => ({ src: v.src || v.getAttribute('src'), type: v.type || null }))
        .filter(v => v.src)

      // All audio
      const audio = [...document.querySelectorAll('audio, audio source')]
        .map(a => ({ src: a.src || a.getAttribute('src'), type: a.type || null }))
        .filter(a => a.src)

      // All links
      const links = [...document.querySelectorAll('a')]
        .map(a => ({ href: a.href, text: a.textContent.trim() }))
        .filter(a => a.href)

      // All headings
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .map(h => ({ tag: h.tagName, text: h.textContent.trim() }))

      // JSON-LD structured data
      const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map(s => { try { return JSON.parse(s.textContent) } catch { return null } })
        .filter(Boolean)

      // Main text content
      const text = document.body?.innerText?.slice(0, 5000) || ''

      return {
        title: document.title,
        url: location.href,
        description: getMeta('description') || getMeta('og:description'),
        thumbnail: getMeta('og:image') || getMeta('twitter:image'),
        siteName: getMeta('og:site_name'),
        type: getMeta('og:type'),
        author: getMeta('author') || getMeta('article:author'),
        keywords: getMeta('keywords'),
        meta,
        images,
        videos,
        audio,
        links,
        headings,
        jsonld,
        text
      }
    })

    setCache(url, data)
    res.json({ ...data, cached: false })

  } catch (e) {
    res.status(500).json({ error: 'Failed to extract: ' + e.message })
  } finally {
    if (page) await page.close()
  }
})

// Clear cache
app.delete('/cache', (req, res) => {
  const url = req.query.url
  if (url) {
    delete cache[url]
    return res.json({ success: true, message: `Cache cleared for ${url}` })
  }
  Object.keys(cache).forEach(k => delete cache[k])
  res.json({ success: true, message: 'All cache cleared' })
})

// Home
app.get('/', (req, res) => {
  res.json({
    name: 'flaska-getinfo',
    version: '1.0.0',
    endpoints: {
      info: 'GET /info?url=https://anysite.com',
      clearCache: 'DELETE /cache?url=https://anysite.com (omit url to clear all)'
    }
  })
})

launchBrowser().then(() => {
  app.listen(PORT, () => console.log(`flaska-getinfo running on port ${PORT}`))
})
