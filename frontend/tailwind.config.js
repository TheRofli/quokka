var config = {
    darkMode: ["class"],
    content: ["./index.html", "./src/**/*.{ts,tsx}"],
    theme: {
        extend: {
            colors: {
                shell: "rgb(var(--color-shell) / <alpha-value>)",
                panel: "rgb(var(--color-panel) / <alpha-value>)",
                "panel-2": "rgb(var(--color-panel-2) / <alpha-value>)",
                milk: "rgb(var(--color-milk) / <alpha-value>)",
                accent: "rgb(var(--color-accent) / <alpha-value>)",
                "accent-soft": "rgb(var(--color-accent-soft) / <alpha-value>)",
                line: "rgb(var(--color-line) / <alpha-value>)",
                success: "rgb(var(--color-success) / <alpha-value>)",
                warning: "rgb(var(--color-warning) / <alpha-value>)",
                danger: "rgb(var(--color-danger) / <alpha-value>)"
            },
            boxShadow: {
                glow: "var(--shadow-glow)",
            },
        },
    },
    plugins: [],
};
export default config;
