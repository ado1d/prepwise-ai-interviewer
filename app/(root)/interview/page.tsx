import InterviewGenerator from "@/components/InterviewGenerator";
import { getCurrentUser } from "@/lib/actions/auth.action";

const Page = async () => {
  const user = await getCurrentUser();

  return (
    <InterviewGenerator userName={user?.name!} userId={user?.id} />
  );
};

export default Page;
