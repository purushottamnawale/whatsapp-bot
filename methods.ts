
export function isLikelyPhoneTarget(rawValue: unknown): boolean {
    // Check if the value is a non-empty string that contains digits and is likely a phone number.

    if (!rawValue) {
        return false;
    }

    const text = String(rawValue).trim();
    if (!text) {
        return false;
    }

    if (/[A-Za-z]/.test(text)) {
        return false;
    }

    const digits = normalizeNumber(text);
    return digits.length >= 8 && digits.length <= 15;
}

export function normalizeNumber(rawNumber: unknown): string {
    // Normalize the input by removing non-digit characters and handling common patterns.

    if (!rawNumber) {
        return '';
    }

    let normalized = String(rawNumber).replace(/\D/g, '');

    if (normalized.startsWith('00')) {
        normalized = normalized.slice(2);
    }

    // Common DE input pattern: +49 0xxxx... -> WhatsApp needs 49xxxx...
    if (normalized.startsWith('490')) {
        normalized = `49${normalized.slice(3)}`;
    }

    return normalized;
}

export function parseBoolean(rawValue: unknown, fallback: boolean): boolean {
    // Interpret common truthy and falsy string values, with a fallback for unrecognized inputs.

    if (rawValue === undefined || rawValue === null || rawValue === '') {
        return fallback;
    }

    const value = String(rawValue).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(value)) {
        return true;
    }
    if (['0', 'false', 'no', 'n', 'off'].includes(value)) {
        return false;
    }

    return fallback;
}

export function parsePositiveInt(rawValue: unknown, fallback: number): number {
    // Accept only positive integers to avoid misconfiguration issues with timeouts and counts.

    const parsed = Number.parseInt(String(rawValue), 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}


export function formatTodayDateWithoutYear(): string {
    const today = new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "long",
        timeZone: "Europe/Berlin"
    }).format(new Date());
    return today;
}

export function formatTodayFullDate(): string {
    const today = new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Europe/Berlin"
    }).format(new Date());
    return today;
}



