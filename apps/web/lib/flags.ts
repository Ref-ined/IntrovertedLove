export const clerkEnabled = () => !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && !!process.env.CLERK_SECRET_KEY;
export const devAuthEnabled = () => process.env.DEV_AUTH === "1" && process.env.NODE_ENV !== "production";
