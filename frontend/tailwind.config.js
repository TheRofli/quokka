var config = {
    darkMode: ["class"],
    content: ["./index.html", "./src/**/*.{ts,tsx}"],
    theme: {
        extend: {
            colors: {
                shell: "#11110f",
                panel: "#1a1917",
                "panel-2": "#211f1b",
                milk: "#f5f0e7",
                accent: "#b08b66",
                "accent-soft": "#8b6b4d",
                line: "rgba(245, 240, 231, 0.12)",
                success: "#8ca56b",
                warning: "#d0a56a",
                danger: "#c67a65"
            },
            boxShadow: {
                glow: "0 0 0 1px rgba(176, 139, 102, 0.14), 0 16px 40px rgba(0, 0, 0, 0.32)",
            },
        },
    },
    plugins: [],
};
export default config;
