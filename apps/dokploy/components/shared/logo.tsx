import { cn } from "@/lib/utils";

interface Props {
	className?: string;
	logoUrl?: string;
}

export const Logo = ({ className = "size-14", logoUrl }: Props) => {
	if (logoUrl) {
		return (
			// biome-ignore lint/performance/noImgElement: this is for dynamic logo loading
			<img
				src={logoUrl}
				alt="Organization Logo"
				className={cn(className, "object-contain rounded-sm")}
			/>
		);
	}

	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 64 64"
			className={className}
			role="img"
			aria-label="Corpo"
		>
			<rect
				x="4"
				y="4"
				width="56"
				height="56"
				rx="14"
				className="fill-primary"
			/>
			<path
				d="M44 21.5A15 15 0 1 0 44 42.5"
				fill="none"
				strokeWidth="6"
				strokeLinecap="round"
				className="stroke-primary-foreground"
			/>
			<rect
				x="30"
				y="26"
				width="10"
				height="4"
				rx="1.5"
				className="fill-primary-foreground"
			/>
			<rect
				x="30"
				y="34"
				width="10"
				height="4"
				rx="1.5"
				className="fill-primary-foreground"
			/>
		</svg>
	);
};
