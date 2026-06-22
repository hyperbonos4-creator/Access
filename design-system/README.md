# VisionYX · Design System

Fuente única de verdad de la identidad de marca para **todos** los productos
VisionYX (Access, Urban, Telecom, Docs, Commerce, Edge). Cambia un token aquí y
se actualiza en cada software que lo consuma.

## Contenido

| Archivo | Qué es |
|---|---|
| `visionyx-tokens.css` | Variables CSS (`--vx-*`): color, tipografía, radios, sombras, degradado. **La base.** |
| `visionyx-ui.css` | Componentes base con clases `.vx-*`: marca, botones, tarjetas, inputs, pills, meter, fondo. |
| `styleguide.html` | Guía viva: abre en el navegador para ver todos los componentes. |
| `brand/` | Logo en sus variantes (isotipo, lockup horizontal, fondo claro, app icon, favicon). |

## Principios

1. **Tokens primero.** Nunca escribas un color a mano (`#22d3ee`); usa `var(--vx-cyan)`.
2. **Marca por identidad, no por decoración.** Orbitron solo para wordmark y
   titulares display; Exo 2 para la interfaz (legibilidad).
3. **Tema oscuro por defecto.** Para fondos claros, envuelve en `.vx-on-light`.
4. **Nombre de producto:** `VISIONYX <Producto>` (Access, Urban, Telecom, Docs, Commerce, Edge).

## Tipografía

Carga las fuentes una vez en cada app:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;700;800&family=Exo+2:wght@400;500;600;700&display=swap" rel="stylesheet">
```

> Para apps **offline** (p. ej. un terminal de puerta), auto-aloja las fuentes en
> `/vendor/fonts` con `@font-face`. Degrada con elegancia a Inter/sistema.

## Cómo consumirlo por stack

### HTML / CSS plano (ej. Access)
```html
<link rel="stylesheet" href="visionyx-tokens.css">
<link rel="stylesheet" href="visionyx-ui.css">

<div class="vx-brand">
  <img class="vx-brand__mark" src="brand/vx-icon-color.svg" alt="">
  <span class="vx-brand__word">VISION<span class="yx">YX</span></span>
</div>
<button class="vx-btn">Acción</button>
```

### React (Vite / CRA) — ej. zora, Manifiestos
```js
import "visionyx-tokens.css";
import "visionyx-ui.css";
// usa className="vx-btn", "vx-card", etc. o lee var(--vx-*) en tu CSS.
```

### Next.js + Tailwind — ej. cicanet
Importa los tokens en `globals.css` y mapéalos en `tailwind.config`:
```js
// tailwind.config.js
theme: { extend: { colors: {
  cyan: "var(--vx-cyan)", brand: "var(--vx-blue)", violet: "var(--vx-violet)",
}}}
```

### MUI — ej. SCRB
```js
import { createTheme } from "@mui/material";
const vx = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export const theme = createTheme({
  palette: {
    mode: "dark",
    primary:   { main: vx("--vx-blue") },
    secondary: { main: vx("--vx-violet") },
    background: { default: vx("--vx-bg"), paper: vx("--vx-panel") },
  },
  typography: { fontFamily: "Exo 2, sans-serif" },
});
```

## Versionado

Cambios de marca → edita `visionyx-tokens.css` y sube la versión en `styleguide.html`.
Idealmente, este folder se publica como paquete (`@visionyx/ui`) o repo git que
cada producto importa como dependencia para mantener una sola fuente de verdad.
