// Skill 注册入口 —— 引入即注册
import { registerSkill } from "./index";
import { standardMinutes } from "./standard";
import { weeklyMeeting } from "./weekly";
import { customerCall } from "./customer";

registerSkill(standardMinutes);
registerSkill(weeklyMeeting);
registerSkill(customerCall);

export { standardMinutes, weeklyMeeting, customerCall };