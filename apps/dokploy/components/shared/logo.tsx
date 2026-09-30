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
			{/* A circle stroke rather than a path, so layouts that restyle SVG paths
			    (e.g. the onboarding wizard) can't paint over the letter. */}
			<circle
				cx="32"
				cy="32"
				r="15"
				fill="none"
				strokeWidth="6"
				strokeLinecap="round"
				strokeDasharray="70.25 24"
				strokeDashoffset="-12"
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
