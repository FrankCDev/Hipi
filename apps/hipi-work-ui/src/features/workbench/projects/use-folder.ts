import { useQuery } from "@tanstack/react-query";
import { useFiles } from "../../../app/client-provider.tsx";

/** A local host read reopens only a previously picker-authorized folder, never Agent context. */
export function useProjectFolder(workspaceId: string, enabled = true) {
	const { fileAuthority } = useFiles();
	return useQuery({
		queryKey: ["projectFolder", workspaceId],
		queryFn: () => {
			if (!fileAuthority?.getProject) throw new Error("UNAVAILABLE");
			return fileAuthority.getProject(workspaceId);
		},
		enabled: enabled && !!workspaceId && !!fileAuthority?.getProject,
		retry: false,
		staleTime: 0,
	});
}
