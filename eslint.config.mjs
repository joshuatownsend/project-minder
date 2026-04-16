import nextConfig from "eslint-config-next";

export default [
  ...nextConfig,
  {
    rules: {
      // setLoading(true) at the start of useEffect is an intentional pattern
      // throughout this codebase for loading state management
      "react-hooks/set-state-in-effect": "off",
    },
  },
];
