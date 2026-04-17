"use strict";

const { nativeImage } = require("electron");
const { iconPath } = require("./paths.cjs");

const ICONS = {
  normal: {
    accent: "#b08b66",
    dot: "#8ca56b",
  },
  warning: {
    accent: "#d0a56a",
    dot: "#d0a56a",
  },
  danger: {
    accent: "#c67a65",
    dot: "#c67a65",
  },
};

function svgForTone(tone = "normal") {
  const colors = ICONS[tone] ?? ICONS.normal;
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <rect width="256" height="256" rx="56" fill="#11110f"/>
      <path d="M70 94c0-31 25-56 56-56h13c31 0 56 25 56 56v28c0 31-25 56-56 56h-8l-34 30c-8 7-20 1-20-10v-29c-5-3-7-7-7-13V94Z" fill="${colors.accent}"/>
      <path d="M96 98c0-10 8-18 18-18h33c10 0 18 8 18 18v18c0 10-8 18-18 18h-33c-10 0-18-8-18-18V98Z" fill="#f5f0e7"/>
      <circle cx="116" cy="107" r="8" fill="#11110f"/>
      <circle cx="146" cy="107" r="8" fill="#11110f"/>
      <path d="M112 148c11 8 28 8 39 0" stroke="#11110f" stroke-width="10" stroke-linecap="round" fill="none"/>
      <circle cx="190" cy="190" r="24" fill="${colors.dot}" stroke="#11110f" stroke-width="10"/>
    </svg>
  `;
}

function iconDataUrl(tone) {
  const svg = svgForTone(tone).replace(/\s+/g, " ").trim();
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function createIcon(tone = "normal") {
  const customIconPath = iconPath();
  if (customIconPath) {
    const image = nativeImage.createFromPath(customIconPath);
    if (!image.isEmpty()) {
      return image;
    }
  }

  return nativeImage.createFromDataURL(iconDataUrl(tone));
}

module.exports = {
  createIcon,
};
