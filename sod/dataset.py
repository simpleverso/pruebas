import os
from transforms import ToTensor, Compose, RandomHorizontalFlip
from coco_utils import get_coco, CocoDetection


def get_coco_dataset(dataset_path: str, train=False) -> CocoDetection:
    """Gets a dataset in torch format from a coco dataset.
    An example dataset can be found in "data/sample-coco-dataset"

    Args:
        dataset_path (str): path to the coco dataset directory.
        train (bool, optional): Whether this is a training dataset. Defaults to False.

    Returns:
        CocoDetection: PyTorch complying Dataset object
    """
    annotation_file_path = os.path.join(dataset_path, "annotations.json")
    transforms = []
    transforms.append(ToTensor())
    if train:
        transforms.append(RandomHorizontalFlip(0.5))
    transforms_composed = Compose(transforms)
    coco_detection_dataset = get_coco(
        os.path.join(dataset_path, "images"), annotation_file_path, transforms_composed
    )
    return coco_detection_dataset


def get_number_of_classes(coco_detection_dataset: CocoDetection) -> int:
    """Gets the number of classes of a CocoDetection dataset"""
    dataset = coco_detection_dataset.coco.dataset
    num_classes = len(dataset["categories"]) + 1
    return num_classes


def get_model_categories_metadata(coco_detection_dataset: CocoDetection):
    """Retrieves the coco format "categories" object from a CocoDetection dataset.

    Args:
        coco_detection_dataset (CocoDetection): [description]

    Returns:
        [type]: [description]
    """
    return coco_detection_dataset.coco.dataset["categories"]
