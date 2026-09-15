import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://radish.dhr.wtf",
  vite: { plugins: [tailwindcss()] },
});
