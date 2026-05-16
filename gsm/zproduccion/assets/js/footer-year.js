/**
 * Replaces a hard-coded year (or " - " trailer) inside any `.copyright`
 * paragraph with the current year. Idempotent and safe to include on
 * every page; if no copyright element is present it does nothing.
 */
(function () {
    function applyYear() {
        var year = String(new Date().getFullYear());
        var nodes = document.querySelectorAll('.copyright');
        nodes.forEach(function (el) {
            var t = el.innerHTML;
            // Replace the first 4-digit year (1900-2099) if any.
            if (/\b(19|20)\d{2}\b/.test(t)) {
                el.innerHTML = t.replace(/\b(19|20)\d{2}\b/, year);
                return;
            }
            // Otherwise, if the copyright ends with a trailing dash/hyphen
            // (legacy markup like "Nacubi research - "), append the year.
            if (/[-·–—]\s*$/.test(el.textContent)) {
                el.innerHTML = t.replace(/\s*$/, ' ' + year);
                return;
            }
            // No year and no trailing dash: append " · YYYY".
            el.innerHTML = t.replace(/\s*$/, ' · ' + year);
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyYear);
    } else {
        applyYear();
    }
})();
