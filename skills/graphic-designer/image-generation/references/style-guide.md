# Image Generation Style Guide

Reference for style modifiers, composition keywords, and use-case recommendations for Gemini Imagen 3.

---

## Style Categories

### Photography
| Modifier | Effect |
|----------|--------|
| `editorial photography` | Magazine-quality, professional, compositionally strong |
| `portrait photography` | Person-focused, bokeh background, face prominence |
| `product photography` | Clean background, studio lighting, commercial quality |
| `street photography` | Candid, urban, natural light |
| `aerial photography` | Top-down perspective, drone-like view |
| `macro photography` | Extreme close-up, texture detail |
| `golden hour` | Warm orange/yellow tones, long shadows |
| `studio lighting` | Controlled, professional, even shadows |
| `cinematic` | Movie-like composition, dramatic lighting, aspect ratio feel |
| `shallow depth of field` | Blurred background, subject isolation |

### Illustration
| Modifier | Effect |
|----------|--------|
| `flat design` | No shadows, solid colors, simple shapes |
| `vector illustration` | Clean edges, scalable look, graphic |
| `line art` | Minimal, outline-only, elegant |
| `watercolor` | Soft edges, translucent washes, artistic |
| `digital painting` | Painterly textures, realistic but artistic |
| `isometric` | 3D-like grid perspective, tech/infrastructure feel |
| `hand-drawn` | Sketchy, organic, personal |
| `geometric` | Abstract shapes, mathematical precision |
| `infographic style` | Data-driven, diagrammatic, explanatory |

### 3D and Render
| Modifier | Effect |
|----------|--------|
| `3D render` | Computer-generated, perfect geometry |
| `clay render` | Matte pastel clay look, playful |
| `glass morphism` | Translucent glass panels, modern UI feel |
| `product visualization` | Hyperrealistic 3D product showcase |
| `low poly` | Geometric facets, stylized 3D |

### Mood and Atmosphere
| Modifier | Effect |
|----------|--------|
| `dark and moody` | Low-key lighting, dramatic shadows |
| `bright and airy` | High-key, lots of white space, light |
| `minimalist` | Clean, sparse, lots of negative space |
| `vibrant` | High saturation, energetic, bold colors |
| `corporate clean` | Professional, neutral, trustworthy |
| `vintage / retro` | Desaturated, film grain, nostalgic |
| `futuristic / sci-fi` | Neon, dark backgrounds, tech aesthetic |
| `warm and cozy` | Amber tones, soft textures, inviting |
| `pastel soft` | Muted pastels, gentle, approachable |

---

## Composition Keywords

| Keyword | Use when |
|---------|----------|
| `negative space on right/left` | Leaving room for text overlay |
| `centered subject` | Subject prominence, symmetry |
| `rule of thirds` | Natural, balanced composition |
| `wide angle` | Showing environment/context |
| `tight crop` | Emotion, intimacy, detail |
| `overhead / bird's eye view` | Flat lay, food, product on surface |
| `low angle` | Power, authority, grandeur |

---

## Color Palette Keywords

| Palette | Keywords |
|---------|----------|
| Corporate blue | `navy blue, clean white, professional` |
| Warm brand | `warm amber, cream, terracotta` |
| Tech/SaaS | `electric blue, dark backgrounds, neon accents` |
| Health/wellness | `sage green, soft white, natural tones` |
| Finance/trust | `deep navy, gold accents, clean` |
| Creative/startup | `vibrant gradients, purple, bold colors` |
| Luxury | `black, gold, minimal, elegant` |

---

## Aspect Ratio Quick Reference

| Ratio | Pixels (approx) | Use cases |
|-------|----------------|-----------|
| `1:1` | 1024×1024 | Instagram feed, avatar, product card, app icon |
| `16:9` | 1920×1080 | Web hero, YouTube thumbnail, banner, presentation |
| `9:16` | 1080×1920 | Instagram Story, TikTok, Pinterest vertical |
| `4:3` | 1280×960 | LinkedIn post, Facebook, blog header |

---

## Known Limitations of Imagen 3

- **Text in images**: Cannot reliably generate readable text. Use Canva for any design requiring legible copy.
- **Exact brand colors**: Color accuracy is approximate — for pixel-perfect brand colors, use Canva.
- **Specific people/faces**: Generates generic representations, not real individuals.
- **Precise layouts**: Cannot guarantee exact positioning of elements — use Canva for layout-critical designs.
- **Logos with text**: Generate the icon/symbol only, then add text in Canva.

---

## Prompt Templates by Use Case

### Hero image (web)
```
[subject/scene], [industry context], [visual style], professional composition, [lighting], [palette], wide angle, negative space on [side] for text, 16:9 ultra realistic
```

### Social media post (Instagram square)
```
[product/subject], [lifestyle context], [style], [mood], [palette], centered composition, square format, high resolution
```

### Profile / avatar
```
[subject], [style], clean background, centered, [palette], professional headshot style, 1:1
```

### Story / vertical
```
[subject], full frame vertical composition, [style], [mood], [palette], 9:16 aspect ratio
```
