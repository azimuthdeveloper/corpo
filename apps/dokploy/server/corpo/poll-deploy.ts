import type { EnqueueDeployment } from "@dokploy/server";
import type { DeploymentJob } from "../queues/queue-types";
import { myQueue } from "../queues/queueSetup";

export const enqueuePolledDeployment: EnqueueDeployment = async ({
	target,
	sha,
	serverId,
}) => {
	const common = {
		titleLog: `Auto-deploy: new commit ${sha.slice(0, 7)}`,
		descriptionLog: `Hash: ${sha}`,
		type: "deploy" as const,
		server: !!serverId,
	};
	const job: DeploymentJob = target.applicationId
		? {
				...common,
				applicationId: target.applicationId,
				applicationType: "application",
			}
		: { ...common, composeId: target.composeId!, applicationType: "compose" };
	return myQueue.add("deployments", job, {
		removeOnComplete: true,
		removeOnFail: true,
	});
};
