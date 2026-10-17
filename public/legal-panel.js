// Legal side-panel controller (Privacy Policy & Terms of Service)
(function () {
  'use strict';

  const cache = {};
  let lastActiveElement = null;

  function init() {
    const panel = document.getElementById('legal-panel');
    if (!panel) return;

    const contentEl = panel.querySelector('.legal-panel-content');
    const loadingEl = panel.querySelector('.legal-panel-loading');
    const tabPrivacy = document.getElementById('legal-tab-privacy');
    const tabTerms = document.getElementById('legal-tab-terms');
    const externalLink = document.getElementById('legal-panel-external');

    function setActiveTab(slug) {
      if (tabPrivacy) {
        tabPrivacy.setAttribute('aria-selected', slug === 'privacy' ? 'true' : 'false');
      }
      if (tabTerms) {
        tabTerms.setAttribute('aria-selected', slug === 'terms' ? 'true' : 'false');
      }
      if (externalLink) {
        externalLink.href = `/${slug}`;
        externalLink.textContent = slug === 'privacy' ? 'Open Privacy page' : 'Open Terms page';
      }
    }

    async function loadContent(slug) {
      if (cache[slug]) {
        if (loadingEl) loadingEl.hidden = true;
        if (contentEl) {
          contentEl.innerHTML = cache[slug];
          contentEl.hidden = false;
        }
        return;
      }

      if (loadingEl) loadingEl.hidden = false;
      if (contentEl) {
        contentEl.innerHTML = '';
        contentEl.hidden = true;
      }

      try {
        const res = await fetch(`/${slug}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const main = doc.querySelector('main.legal') || doc.body;

        // Remove the top brand link since we are inside SangAI's panel
        const brand = main.querySelector('.legal-brand');
        if (brand) brand.remove();

        // Convert internal legal cross-links to switch panel tab
        const crossLinks = main.querySelectorAll('a[href="/privacy"], a[href="/terms"]');
        crossLinks.forEach(a => {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            const targetSlug = a.getAttribute('href').replace('/', '');
            openPanel(targetSlug);
          });
        });

        cache[slug] = main.innerHTML;
        if (loadingEl) loadingEl.hidden = true;
        if (contentEl) {
          contentEl.innerHTML = cache[slug];
          contentEl.hidden = false;
        }
      } catch (err) {
        if (loadingEl) loadingEl.hidden = true;
        if (contentEl) {
          contentEl.innerHTML = `<p class="legal-panel-error">Could not load content. <a href="/${slug}" target="_blank" rel="noopener">Open ${slug} in a new tab</a>.</p>`;
          contentEl.hidden = false;
        }
      }
    }

    function openPanel(slug) {
      slug = slug === 'terms' ? 'terms' : 'privacy';
      if (panel.hidden) {
        lastActiveElement = document.activeElement;
        panel.hidden = false;
        document.body.style.overflow = 'hidden';
      }
      setActiveTab(slug);
      loadContent(slug);

      // Set focus to the active tab or close button for keyboard accessibility
      const targetTab = slug === 'terms' ? tabTerms : tabPrivacy;
      if (targetTab) {
        targetTab.focus();
      }
    }

    function closePanel() {
      if (panel.hidden) return;
      panel.hidden = true;
      document.body.style.overflow = '';
      if (location.hash === '#privacy' || location.hash === '#terms') {
        history.replaceState(null, '', location.pathname + location.search);
      }
      if (lastActiveElement && typeof lastActiveElement.focus === 'function') {
        lastActiveElement.focus();
      }
    }

    // Intercept clicks on legal links
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[href="/privacy"], a[href="/terms"]');
      if (!link) return;

      // Allow modifier-key clicks (new tab / window)
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
        return;
      }

      e.preventDefault();
      const slug = link.getAttribute('href').replace('/', '');
      openPanel(slug);
    });

    // Close button and backdrop clicks
    panel.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="close"]')) {
        closePanel();
      }
    });

    // Tab buttons
    if (tabPrivacy) {
      tabPrivacy.addEventListener('click', () => openPanel('privacy'));
    }
    if (tabTerms) {
      tabTerms.addEventListener('click', () => openPanel('terms'));
    }

    // Keyboard navigation (Escape to close)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) {
        closePanel();
      }
    });

    // Open from hash if present
    if (location.hash === '#privacy') {
      openPanel('privacy');
    } else if (location.hash === '#terms') {
      openPanel('terms');
    }

    window.addEventListener('hashchange', () => {
      if (location.hash === '#privacy') {
        openPanel('privacy');
      } else if (location.hash === '#terms') {
        openPanel('terms');
      }
    });

    window.LegalPanel = { open: openPanel, close: closePanel };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
