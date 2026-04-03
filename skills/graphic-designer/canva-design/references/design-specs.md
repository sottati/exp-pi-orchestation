# Canva Design Specs Reference

Dimensions, formats, and best practices for each design type available via the Canva API.

---

## Design Types and Recommended Dimensions

| `designType` | Canva equivalent | Common dimensions | Use cases |
|-------------|-----------------|-------------------|-----------|
| `poster` | Poster / Flyer | 794×1123px (A4) · 1080×1920px (digital) | Event flyers, announcements, afiches, carteles |
| `social_media` | Social Media Post | 1080×1080px (square) · 1080×1920px (story) · 1200×628px (LinkedIn) | Instagram, Facebook, LinkedIn, Twitter posts |
| `banner` | Banner / Header | 1200×628px · 728×90px (leaderboard) · 300×250px (medium rectangle) | Web banners, email headers, ad banners |
| `presentation` | Presentation | 1920×1080px (16:9 widescreen) · 1024×768px (4:3) | Pitch decks, reports, demos, slideshows |

---

## Export Format Decision

| Format | Best for | Notes |
|--------|----------|-------|
| PNG | Web, social media, assets with transparency | Lossless, larger file size |
| JPG | Photography-heavy designs, email | Smaller file, no transparency |
| PDF | Print, formal documents, presentations | Vector elements preserved, print-ready |

**Rules of thumb:**
- Social media posts → PNG (preserves quality on upload)
- Print flyers → PDF (printers expect it)
- Web banners → PNG or JPG depending on transparency needs
- Presentations to share digitally → PDF

---

## Canva API Workflow

```
canva_create(title, designType)
  → returns { designId, editUrl, viewUrl }

canva_get(designId)
  → returns { title, thumbnail, editUrl, viewUrl, status }

canva_export(designId, format)   ← waits up to 60s
  → returns { downloadUrl }
```

**Always return `editUrl`** to the user so they can customize the design in Canva directly.

---

## Design Principles Checklist

Before considering a design complete, verify:

- [ ] **Hierarchy**: Is the most important element the most visually prominent?
- [ ] **Contrast**: Is all text legible against its background? (Minimum 4.5:1 contrast ratio for accessibility)
- [ ] **Whitespace**: Is there enough breathing room, or is it cluttered?
- [ ] **Consistency**: Same font family, color palette across all pieces of a campaign?
- [ ] **CTA**: Is the call-to-action clear and visually distinct?
- [ ] **Brand**: Are brand colors and logo applied correctly?

---

## Common Canva Design Patterns

### Social Media Post (Square 1:1)
- Bold headline at top or center
- Visual/image takes 60-70% of the space
- Logo + handle at bottom
- Max 2-3 font sizes

### Event Flyer (Poster)
- Event name — largest element
- Date, time, location — secondary
- Visual theme fills background
- CTA at bottom (register at URL / scannable QR)

### Web Banner (16:9 or rectangular)
- Headline on left, visual on right (or vice versa)
- Background keeps enough contrast for text
- CTA button is visually distinct (contrasting color)
- Logo top-left corner

### Presentation Slide (16:9)
- One key message per slide
- Max 5-7 lines of text per slide
- Data visualized as chart/graph, not as text tables
- Consistent header/footer across all slides
