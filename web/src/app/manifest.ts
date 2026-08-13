import type { MetadataRoute } from "next";

/**
 * The dashboard is a single-user tool that lives in a pinned tab or on a phone
 * home screen, so the manifest exists mainly to control how it looks once it is
 * installed: standalone chrome, and a background that matches the dark theme in
 * globals.css so there is no white flash on launch.
 *
 * The icons here are the full-bleed square renders, not the rounded tile in
 * `icon.svg`. Android masks maskable icons itself, and feeding it artwork that
 * already has rounded corners double-rounds the result.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ledger",
    short_name: "Ledger",
    description: "Personal financial ledger built from bank SMS",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      {
        src: "/brand/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/brand/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
