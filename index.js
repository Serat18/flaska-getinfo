const express = require('express')
const { chromium } = require('playwright')

const app = express()
const PORT = 3000
const CACHE_TTL = 10 * 60 * 1000

const cache = {}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', '*')
  res.header('Access-Control-Allow-Methods', '*')
  next()
})

let browser = null
let browserRestarting = false

async function launchBrowser() {
  if (browserRestarting) return
  browserRestarting = true
  try {
    if (browser) {
      try { await browser.close() } catch {}
    }
    browser = await chromium.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions'
      ]
    })
    browser.on('disconnected', () => {
      console.log('Browser disconnected, restarting in 3s...')
      browser = null
      setTimeout(launchBrowser, 3000)
    })
    console.log('Browser launched!')
  } catch (e) {
    console.error('Browser launch failed:', e.message, '— retrying in 5s')
    setTimeout(launchBrowser, 5000)
  } finally {
    browserRestarting = false
  }
}

function getCached(url) {
  const entry = cache[url]
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL) { delete cache[url]; return null }
  return entry.data
}

function setCache(url, data) {
  cache[url] = { data, timestamp: Date.now() }
}

app.get('/info', async (req, res) => {
  const url = req.query.url
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' })
  try { new URL(url) } catch { return res.status(400).json({ error: 'Invalid URL' }) }

  const cached = getCached(url)
  if (cached) return res.json({ ...cached, cached: true })

  if (!browser || !browser.isConnected()) {
    return res.status(503).json({ error: 'Browser restarting, try again in a few seconds' })
  }

  let page;
  try {
    page = await browser.newPage()
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })

    const data = await page.evaluate(() => {
      const getMeta = (name) =>
        document.querySelector(`meta[name="${name}"]`)?.content ||
        document.querySelector(`meta[property="${name}"]`)?.content || null

      const meta = {}
      document.querySelectorAll('meta').forEach(m => {
        const key = m.getAttribute('name') || m.getAttribute('property')
        const val = m.getAttribute('content')
        if (key && val) meta[key] = val
      })

      const images = [...document.querySelectorAll('img')]
        .map(img => ({ src: img.src, alt: img.alt, width: img.width, height: img.height }))
        .filter(img => img.src)

      const videos = [...document.querySelectorAll('video, video source')]
        .map(v => ({ src: v.src || v.getAttribute('src'), type: v.type || null }))
        .filter(v => v.src)

      const audio = [...document.querySelectorAll('audio, audio source')]
        .map(a => ({ src: a.src || a.getAttribute('src'), type: a.type || null }))
        .filter(a => a.src)

      const links = [...document.querySelectorAll('a')]
        .map(a => ({ href: a.href, text: a.textContent.trim() }))
        .filter(a => a.href)

      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .map(h => ({ tag: h.tagName, text: h.textContent.trim() }))

      const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map(s => { try { return JSON.parse(s.textContent) } catch { return null } })
        .filter(Boolean)

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
    if (page) { try { await page.close() } catch {} }
  }
})

app.delete('/cache', (req, res) => {
  const url = req.query.url
  if (url) { delete cache[url]; return res.json({ success: true, message: `Cache cleared for ${url}` }) }
  Object.keys(cache).forEach(k => delete cache[k])
  res.json({ success: true, message: 'All cache cleared' })
})

app.get('/', (req, res) => {
  res.json({
    name: 'flaska-getinfo',
    version: '1.0.0',
    browser: browser?.isConnected() ? 'ready' : 'restarting',
    endpoints: {
      info: 'GET /info?url=https://anysite.com',
      clearCache: 'DELETE /cache?url=https://anysite.com'
    }
  })
})

launchBrowser().then(() => {
  app.listen(PORT, () => console.log(`flaska-getinfo running on port ${PORT}`))
})
