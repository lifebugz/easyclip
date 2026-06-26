<script lang="ts">
  import type { Snippet } from 'svelte';
  import '../app.css';
  import { getLang } from '../lib/i18n/index.svelte';
  import LanguageToggle from '../lib/components/LanguageToggle.svelte';

  let { children }: { children: Snippet } = $props();

  $effect(() => {
    const lang = getLang();
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  });
</script>

<header class="flex items-center px-8 pt-4">
  <LanguageToggle />
</header>

{@render children()}
